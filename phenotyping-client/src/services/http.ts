// HTTP client factory — creates a configured fetch-based client for the backend API.
// The base URL is configurable so callers can override it at runtime.
//
// FE-029 added:
//   - Bearer token attachment from the auth store on every request.
//   - Response interceptor: on 401 `token_expired`, run a single-flight refresh
//     and retry the original request once. On `token_invalid`/`token_revoked`,
//     force-logout. Other 401s pass through as ApiError.
//   - Concurrent requests during a refresh share one in-flight refresh promise
//     so we never hit /auth/refresh more than once per access expiry.

import { ApiError } from './errors';
import { getAccessToken, loadRefreshToken, useAuthStore } from '@/stores/authStore';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ── Base URL singleton ─────────────────────────────────────────────────────────

let _baseUrl: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

type BaseUrlListener = (url: string) => void;
const _baseUrlListeners = new Set<BaseUrlListener>();

/** Return the current base URL used by all API calls. */
export function getBaseUrl(): string {
    return _baseUrl;
}

/** Update the base URL (e.g. when the user changes the backend address in settings). */
export function setBaseUrl(url: string): void {
    if (_baseUrl === url) return;
    _baseUrl = url;
    for (const cb of _baseUrlListeners) {
        try {
            cb(url);
        } catch {
            // listener errors must not affect other listeners
        }
    }
}

/** Subscribe to base URL changes (e.g. for WS reconnection). Returns an unsubscribe fn. */
export function onBaseUrlChange(cb: BaseUrlListener): () => void {
    _baseUrlListeners.add(cb);
    return () => _baseUrlListeners.delete(cb);
}

function _url(path: string): string {
    // Allow callers to pass either a relative path ("analyses/abc") or an
    // already-built absolute URL (from getBaseUrl() helpers). Detecting absolute
    // URLs lets shared helpers like getOverlayImageUrl() keep returning full
    // URLs while still flowing through the auth interceptor.
    if (/^https?:\/\//i.test(path)) return path;
    return `${_baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

// ── Auth header + single-flight refresh ────────────────────────────────────────

function _authHeader(): Record<string, string> {
    const token = getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

let _refreshInFlight: Promise<boolean> | null = null;
const ACCESS_REFRESH_SKEW_SECONDS = 5;

function _parsePath(url: string): string {
    // _baseUrl can be relative (e.g. "/api" behind a reverse proxy), so the
    // built URL may be path-only. Pass window.location.origin as the base so
    // ``new URL`` succeeds in both absolute and relative cases.
    const base =
        typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    return new URL(url, base).pathname;
}

function _isAuthEndpoint(url: string): boolean {
    return _parsePath(url).includes('/auth/');
}

function _isPublicEndpoint(url: string): boolean {
    const path = _parsePath(url);
    return path.endsWith('/health') || path.endsWith('/ping');
}

function _decodeJwtPayload(token: string): Record<string, unknown> | null {
    const [, payload] = token.split('.');
    if (!payload) return null;
    try {
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
        return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function _accessTokenNeedsRefresh(token: string | null): boolean {
    if (!token) return true;
    const payload = _decodeJwtPayload(token);
    const exp = payload?.exp;
    if (typeof exp !== 'number') return false;
    const nowSeconds = Date.now() / 1000;
    return exp <= nowSeconds + ACCESS_REFRESH_SKEW_SECONDS;
}

function _shouldRefreshBeforeRequest(url: string): boolean {
    if (_isAuthEndpoint(url) || _isPublicEndpoint(url)) return false;
    if (!loadRefreshToken()) return false;
    return _accessTokenNeedsRefresh(getAccessToken());
}

/**
 * Run a single-flight refresh.
 *
 * Returns true if a fresh access token is now in the store, false on failure
 * (in which case the caller should give up — the user has been forced out).
 *
 * Implemented inline (not via api.ts) to avoid a circular import between
 * services/http.ts and services/auth.ts.
 */
async function _refreshAccess(): Promise<boolean> {
    if (_refreshInFlight) return _refreshInFlight;

    _refreshInFlight = (async () => {
        const refresh = loadRefreshToken();
        if (!refresh) {
            _forceLogout();
            return false;
        }
        try {
            const response = await fetch(_url('auth/refresh'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refresh }),
            });
            if (!response.ok) {
                // Any non-2xx on /auth/refresh means the refresh token is unusable.
                _forceLogout();
                return false;
            }
            const json = (await response.json()) as {
                access_token: string;
                refresh_token: string;
            };
            useAuthStore.getState().setTokens(json.access_token, json.refresh_token);
            return true;
        } catch {
            _forceLogout();
            return false;
        } finally {
            _refreshInFlight = null;
        }
    })();

    return _refreshInFlight;
}

let _onForceLogout: (() => void) | null = null;

/** Register a callback fired when the refresh token is no longer usable. */
export function onForceLogout(cb: () => void): () => void {
    _onForceLogout = cb;
    return () => {
        if (_onForceLogout === cb) _onForceLogout = null;
    };
}

function _forceLogout(): void {
    useAuthStore.getState().clear();
    _onForceLogout?.();
}

// ── Internal helpers ────────────────────────────────────────────────────────────

interface ParsedError {
    status: number;
    detail: string | null;
    code: string | null;
}

async function _parseError(response: Response): Promise<ParsedError> {
    let detail: string | null = null;
    let code: string | null = null;
    try {
        const json = (await response.json()) as {
            detail?: string | { code?: string; message?: string } | unknown;
        };
        if (typeof json.detail === 'string') {
            detail = json.detail;
        } else if (json.detail && typeof json.detail === 'object') {
            const d = json.detail as { code?: string; message?: string };
            if (typeof d.code === 'string') code = d.code;
            if (typeof d.message === 'string') detail = d.message;
        }
    } catch {
        detail = response.statusText || null;
    }
    return { status: response.status, detail, code };
}

async function _doFetch(
    method: HttpMethod,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
): Promise<Response> {
    const url = _url(path);
    const headers: Record<string, string> = { ..._authHeader() };
    if (body != null) headers['Content-Type'] = 'application/json';

    return fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal,
    });
}

async function _doFetchFormData(
    method: HttpMethod,
    path: string,
    fieldName: string,
    files: File[],
    params: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
): Promise<Response> {
    let url = _url(path);
    if (params) {
        const qs = new URLSearchParams(params).toString();
        url = `${url}?${qs}`;
    }
    const form = new FormData();
    for (const file of files) {
        form.append(fieldName, file, file.name);
    }
    return fetch(url, { method, body: form, signal, headers: { ..._authHeader() } });
}

/** Wrap a fetch and apply 401 → refresh-and-retry once. */
async function _withRefresh(doFetch: () => Promise<Response>, url: string): Promise<Response> {
    if (_shouldRefreshBeforeRequest(url)) {
        const ok = await _refreshAccess();
        if (!ok && !getAccessToken()) {
            throw new ApiError(401, 'Session expired', 'token_expired');
        }
    }

    let response: Response;
    try {
        response = await doFetch();
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        throw new ApiError(
            0,
            `Network error: could not connect to ${url}. Is the backend running?`,
        );
    }

    if (response.status !== 401) return response;

    // Don't try to refresh on /auth/* itself — those endpoints failing means
    // the credentials were bad, not that we need a new access token.
    if (_isAuthEndpoint(url)) return response;

    const parsed = await _parseError(response.clone());
    if (parsed.code === 'token_invalid' || parsed.code === 'token_revoked') {
        _forceLogout();
        throw new ApiError(parsed.status, parsed.detail, parsed.code);
    }
    if (parsed.code !== 'token_expired') {
        // 401 from a non-auth source — pass through.
        throw new ApiError(parsed.status, parsed.detail, parsed.code);
    }

    // token_expired: try a single refresh, then retry once.
    const ok = await _refreshAccess();
    if (!ok) {
        throw new ApiError(parsed.status, parsed.detail, parsed.code);
    }
    try {
        response = await doFetch();
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        throw new ApiError(
            0,
            `Network error: could not connect to ${url}. Is the backend running?`,
        );
    }
    return response;
}

async function _fetch<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
): Promise<T> {
    const url = _url(path);
    const response = await _withRefresh(() => _doFetch(method, path, body, signal), url);
    return _parseResponse(response);
}

async function _fetchFormData<T>(
    method: HttpMethod,
    path: string,
    fieldName: string,
    files: File[],
    params?: Record<string, string>,
    signal?: AbortSignal,
): Promise<T> {
    const url = _url(path);
    const response = await _withRefresh(
        () => _doFetchFormData(method, path, fieldName, files, params, signal),
        url,
    );
    return _parseResponse(response);
}

async function _parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const { status, detail, code } = await _parseError(response);
        throw new ApiError(status, detail, code);
    }
    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export const http = {
    async get<T>(path: string, signal?: AbortSignal): Promise<T> {
        return _fetch<T>('GET', path, undefined, signal);
    },

    async post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        return _fetch<T>('POST', path, body, signal);
    },

    async put<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        return _fetch<T>('PUT', path, body, signal);
    },

    async patch<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        return _fetch<T>('PATCH', path, body, signal);
    },

    async delete(path: string, signal?: AbortSignal): Promise<void> {
        await _fetch<void>('DELETE', path, undefined, signal);
    },

    /**
     * Fetch a binary resource (e.g. overlay PNG) with the same Bearer + refresh
     * dance the JSON helpers use. Required because <img src=...> can't carry an
     * Authorization header on its own.
     */
    async getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
        const url = _url(path);
        const response = await _withRefresh(
            () =>
                fetch(url, {
                    method: 'GET',
                    headers: { ..._authHeader() },
                    signal,
                }),
            url,
        );
        if (!response.ok) {
            const { status, detail, code } = await _parseError(response);
            throw new ApiError(status, detail, code);
        }
        return response.blob();
    },

    /**
     * Multipart single-file upload — sends FormData with the file under `fieldName`.
     * Optionally appends query params.
     */
    async postFormData<T>(
        path: string,
        fieldName: string,
        file: File,
        params?: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<T> {
        return _fetchFormData<T>('POST', path, fieldName, [file], params, signal);
    },

    /**
     * Multipart multi-file upload — sends FormData with multiple files under `fieldName`.
     * Optionally appends query params.
     */
    async postFormDataMulti<T>(
        path: string,
        fieldName: string,
        files: File[],
        params?: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<T> {
        return _fetchFormData<T>('POST', path, fieldName, files, params, signal);
    },
};
