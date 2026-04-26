// BootProvider — fetches /health once at app start so:
//
//   1. The router doesn't render before we know the backend is reachable.
//   2. Per-organism `models_status` is cached and shared, so AnalyzePage
//      (and anything else that needs it) doesn't have to re-fetch.
//
// Boot phases:
//   "loading" — request in flight, splash visible (LoadingScreen).
//   "ready"   — /health succeeded, app renders normally.
//   "error"   — request failed or timed out; splash shows a "Retry" action.
//
// Page-specific data (dashboard stats, model assignments, …) intentionally
// stays out of this gate — those have their own per-page skeletons and would
// only slow first paint if blocked here.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/LoadingScreen";
import { getHealth } from "@/services/api";
import type { HealthResponse, ModelStatus, Organism } from "@/types/api";

type BootPhase = "loading" | "ready" | "error";

interface BootState {
  phase: BootPhase;
  modelsStatus: Partial<Record<Organism, ModelStatus>>;
  health: HealthResponse | null;
  error: string | null;
  retry: () => void;
  /** Re-fetch /health without showing the splash again — useful after
   *  uploading/assigning a model so AnalyzePage updates without a reload. */
  refresh: () => Promise<void>;
}

const BootContext = createContext<BootState | null>(null);

const BOOT_TIMEOUT_MS = 10_000;

export function BootProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<BootPhase>("loading");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attemptIdRef = useRef(0);

  const runBoot = useCallback(async (): Promise<void> => {
    const id = ++attemptIdRef.current;
    setPhase("loading");
    setError(null);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BOOT_TIMEOUT_MS);

    try {
      const data = await getHealth(controller.signal);
      if (attemptIdRef.current !== id) return;
      setHealth(data);
      setPhase("ready");
    } catch (err) {
      if (attemptIdRef.current !== id) return;
      const aborted = err instanceof DOMException && err.name === "AbortError";
      const msg = aborted
        ? `Backend did not respond within ${Math.round(BOOT_TIMEOUT_MS / 1000)}s.`
        : err instanceof Error
          ? err.message
          : String(err);
      setError(msg);
      setPhase("error");
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  // Refresh = re-fetch /health silently (no splash, just update cached value).
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await getHealth();
      setHealth(data);
    } catch {
      /* keep whatever we last had */
    }
  }, []);

  useEffect(() => {
    void runBoot();
  }, [runBoot]);

  const value = useMemo<BootState>(
    () => ({
      phase,
      health,
      modelsStatus: health?.models_status ?? {},
      error,
      retry: () => void runBoot(),
      refresh,
    }),
    [phase, health, error, runBoot, refresh],
  );

  if (phase === "loading") {
    return <LoadingScreen status="Connecting to backend…" />;
  }
  if (phase === "error") {
    return (
      <LoadingScreen
        status={`Cannot reach backend — ${error ?? "unknown error"}`}
        action={
          <Button onClick={() => void runBoot()} variant="default">
            Retry
          </Button>
        }
      />
    );
  }
  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
}

export function useBoot(): BootState {
  const ctx = useContext(BootContext);
  if (ctx === null) {
    throw new Error("useBoot must be used inside <BootProvider>");
  }
  return ctx;
}
