import { useEffect, useRef, useState } from "react";

/**
 * Delays showing a loading indicator until `loading` has been true for `delayMs`.
 * Prevents spinner flash on fast requests that resolve in < delayMs.
 */
export function useDelayedLoading(loading: boolean, delayMs = 250): boolean {
  const [show, setShow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loading) {
      setShow(false);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    const t = setTimeout(() => setShow(true), delayMs);
    timerRef.current = t;
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [loading, delayMs]);

  return show;
}
