// HTTP client factory — creates a configured fetch-based client for the backend API.
// The base URL is configurable so callers can override it at runtime.

import { ApiError } from "./errors";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ── Base URL singleton ─────────────────────────────────────────────────────────

let _baseUrl: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

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
  return `${_baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

// ── Internal helpers ────────────────────────────────────────────────────────────

async function _fetch<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = _url(path);
  const headers: Record<string, string> =
    body != null ? { "Content-Type": "application/json" } : {};

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError(0, `Network error: could not connect to ${url}. Is the backend running?`);
  }

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
  let url = _url(path);
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url = `${url}?${qs}`;
  }
  const form = new FormData();
  for (const file of files) {
    form.append(fieldName, file, file.name);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, body: form, signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError(0, `Network error: could not connect to ${url}. Is the backend running?`);
  }

  return _parseResponse(response);
}

async function _parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail: string | null = null;
    try {
      const json = (await response.json()) as { detail?: string };
      detail = json.detail ?? null;
    } catch {
      detail = response.statusText || null;
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export const http = {
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return _fetch<T>("GET", path, undefined, signal);
  },

  async post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return _fetch<T>("POST", path, body, signal);
  },

  async put<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return _fetch<T>("PUT", path, body, signal);
  },

  async patch<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return _fetch<T>("PATCH", path, body, signal);
  },

  async delete(path: string, signal?: AbortSignal): Promise<void> {
    await _fetch<void>("DELETE", path, undefined, signal);
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
    return _fetchFormData<T>("POST", path, fieldName, [file], params, signal);
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
    return _fetchFormData<T>("POST", path, fieldName, files, params, signal);
  },
};
