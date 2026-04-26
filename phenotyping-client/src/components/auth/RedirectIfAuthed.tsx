// Inverse guard for /login and /register — sends authenticated users to "/"
// (or wherever they were trying to go before being kicked to /login).

import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

export function RedirectIfAuthed() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();
  const from =
    (location.state as { from?: string } | null)?.from ?? "/";

  if (status === "authed") {
    return <Navigate to={from} replace />;
  }
  return <Outlet />;
}
