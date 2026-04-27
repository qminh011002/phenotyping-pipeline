// Route guard — redirects unauthenticated users to /login, preserving the
// originally-requested path in `location.state.from` so the login flow can
// bounce back after success.

import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

export function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === "boot") {
    // BootProvider holds the splash; this branch should not normally render,
    // but if it does we render nothing to avoid flashing /login.
    return null;
  }
  if (status !== "authed") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
