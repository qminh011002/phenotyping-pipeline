// HTTP client factory — creates a configured fetch-based client for the backend API.
// The base URL is configurable so callers can override it at runtime.

import { ApiError } from "./errors";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

// ── Base URL singleton ─────────────────────────────────────────────────────────

let _baseUrl: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

/** Return the current base URL used by all API calls. */
export function getBaseUrl(): string {
  return _baseUrl;
}

/** Update the base URL (e.g. when the user changes the backend address in settings). */
export function setBaseUrl(url: string): void {
  _baseUrl = url;
}

function _url(path: string): string {
  return `${_baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

// ── Internal helpers ────────────────────────────────────────────────────────────

async function _fetch<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const url = _url(path);
  const headers: Record<string, string> = body !== undefined ? { "Content-Type": "application/json" } : {};

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, `Network error: could not connect to ${url}. Is the backend running?`);
  }

  return _parseResponse(response);
}

async function _fetchFormData<T>(method: HttpMethod, path: string, fieldName: string, files: File[]): Promise<T> {
  const url = _url(path);
  const form = new FormData();
  for (const file of files) {
    form.append(fieldName, file, file.name);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, body: form });
  } catch {
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
  async get<T>(path: string): Promise<T> {
    return _fetch<T>("GET", path);
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    return _fetch<T>("POST", path, body);
  },

  async put<T>(path: string, body?: unknown): Promise<T> {
    return _fetch<T>("PUT", path, body);
  },

  async delete(path: string): Promise<void> {
    await _fetch<void>("DELETE", path);
  },

  /**
   * Multipart single-file upload — sends FormData with the file under `fieldName`.
   */
  async postFormData<T>(path: string, fieldName: string, file: File): Promise<T> {
    return _fetchFormData<T>("POST", path, fieldName, [file]);
  },

  /**
   * Multipart multi-file upload — sends FormData with multiple files under `fieldName`.
   */
  async postFormDataMulti<T>(path: string, fieldName: string, files: File[]): Promise<T> {
    return _fetchFormData<T>("POST", path, fieldName, files);
  },
};
