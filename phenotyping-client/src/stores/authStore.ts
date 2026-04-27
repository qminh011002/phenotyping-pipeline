// authStore — single source of truth for the authenticated session.
//
// Token storage policy (FE-029):
//   - access token: in-memory only (this store). Lost on reload — that's fine,
//     the boot flow uses the persisted refresh token to mint a fresh access.
//   - refresh token: localStorage. We accept the XSS-exposure tradeoff in
//     exchange for simplicity; httpOnly cookies aren't workable across the
//     desktop (Tauri) + Vite dev origins. Revisit if this app ever ships to a
//     hostile origin context.
// TODO(security): move refresh token to a more secure store when we have one
//   (Tauri Store plugin, OS keychain, etc.).
//
// Status:
//   "boot"  — initial page load; we haven't decided yet whether the persisted
//             refresh token can be exchanged for an access token.
//   "anon"  — no valid session; routes guarded by RequireAuth redirect to /login.
//   "authed"— we have a user + access token in memory.

import { create } from "zustand";
import type { UserOut } from "@/types/api";

const REFRESH_KEY = "phenotyping.refresh_token";

export function loadRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function saveRefreshToken(token: string | null): void {
  try {
    if (token == null) window.localStorage.removeItem(REFRESH_KEY);
    else window.localStorage.setItem(REFRESH_KEY, token);
  } catch {
    /* storage may be disabled — best-effort */
  }
}

export type AuthStatus = "boot" | "anon" | "authed";

interface AuthState {
  status: AuthStatus;
  user: UserOut | null;
  accessToken: string | null;
  setSession: (user: UserOut, accessToken: string, refreshToken: string) => void;
  /** Update tokens after a refresh without changing the user. */
  setTokens: (accessToken: string, refreshToken: string) => void;
  setStatus: (status: AuthStatus) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "boot",
  user: null,
  accessToken: null,

  setSession: (user, accessToken, refreshToken) => {
    saveRefreshToken(refreshToken);
    set({ status: "authed", user, accessToken });
  },

  setTokens: (accessToken, refreshToken) => {
    saveRefreshToken(refreshToken);
    set({ accessToken });
  },

  setStatus: (status) => set({ status }),

  clear: () => {
    saveRefreshToken(null);
    set({ status: "anon", user: null, accessToken: null });
  },
}));

/** Read access token without subscribing — used by the http interceptor. */
export function getAccessToken(): string | null {
  return useAuthStore.getState().accessToken;
}
