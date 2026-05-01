// Auth API client (FE-029) — wraps the BE-020 endpoints.
// Calls /auth/* directly (without going through the http interceptor's
// refresh dance) since these endpoints are the source of refresh tokens.

import { ApiError } from './errors';
import { getBaseUrl } from './http';
import { loadRefreshToken, useAuthStore } from '@/stores/authStore';
import type { AuthResponse, TokenPair, UserOut } from '@/types/api';

function _url(path: string): string {
    return `${getBaseUrl().replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function _post<T>(path: string, body: unknown, accessToken?: string): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const url = _url(path);
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, `Network error: could not connect to ${url}.`);
    }
    if (response.status === 204) return undefined as T;
    if (!response.ok) {
        let detail: string | null = null;
        let code: string | null = null;
        try {
            const json = (await response.json()) as {
                detail?: string | { code?: string; message?: string };
            };
            if (typeof json.detail === 'string') detail = json.detail;
            else if (json.detail && typeof json.detail === 'object') {
                const d = json.detail as { code?: string; message?: string };
                if (typeof d.code === 'string') code = d.code;
                if (typeof d.message === 'string') detail = d.message;
            }
        } catch {
            detail = response.statusText || null;
        }
        throw new ApiError(response.status, detail, code);
    }
    return (await response.json()) as T;
}

export async function register(
    email: string,
    password: string,
    name: string | null,
): Promise<AuthResponse> {
    const resp = await _post<AuthResponse>('auth/register', {
        email,
        password,
        name,
    });
    useAuthStore.getState().setSession(resp.user, resp.access_token, resp.refresh_token);
    return resp;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
    const resp = await _post<AuthResponse>('auth/login', { email, password });
    useAuthStore.getState().setSession(resp.user, resp.access_token, resp.refresh_token);
    return resp;
}

/** Best-effort logout — revokes the refresh token server-side and clears local state.
 *  We always clear local state, even if the server call fails. */
export async function logout(): Promise<void> {
    const refresh = loadRefreshToken();
    try {
        if (refresh) {
            await _post<void>('auth/logout', { refresh_token: refresh });
        }
    } catch {
        /* swallow — local cleanup is what matters */
    } finally {
        useAuthStore.getState().clear();
    }
}

/** Manual refresh — used by BootProvider on app start. */
export async function refresh(): Promise<TokenPair | null> {
    const refresh = loadRefreshToken();
    if (!refresh) return null;
    try {
        const resp = await _post<TokenPair>('auth/refresh', { refresh_token: refresh });
        useAuthStore.getState().setTokens(resp.access_token, resp.refresh_token);
        return resp;
    } catch {
        return null;
    }
}

/** GET /auth/me — uses the current access token from the store. */
export async function me(accessToken?: string): Promise<UserOut> {
    const url = _url('auth/me');
    const token = accessToken ?? useAuthStore.getState().accessToken;
    if (!token) throw new ApiError(401, 'No access token');
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new ApiError(response.status, response.statusText);
    }
    return (await response.json()) as UserOut;
}
