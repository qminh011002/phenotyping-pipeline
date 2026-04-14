// AnimatedNumber — smoothly tweens between numeric values using Framer Motion.
// Renders tabular-nums so column width stays stable during transitions.
// Used for dashboard metric counts and the result egg count.

import { useEffect, useRef } from "react";
import { animate, type EasingDefinition } from "framer-motion";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  className?: string;
  /** Duration in seconds. Defaults to 0.6. */
  duration?: number;
}

function easeOut(): EasingDefinition {
  return [0.32, 0.72, 0, 1] as EasingDefinition;
}

export function AnimatedNumber({
  value,
  decimals = 0,
  className,
  duration = 0.6,
}: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevValue = useRef<number>(value);
  const shouldReduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (shouldReduce) {
      el.textContent = decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString();
      prevValue.current = value;
      return;
    }

    const controls = animate(prevValue.current, value, {
      duration,
      ease: easeOut(),
      onUpdate: (v) => {
        el.textContent = decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString();
      },
      onComplete: () => {
        prevValue.current = value;
      },
    });

    return () => controls.stop();
    // Only re-animate when `value` changes — intentionally exclude duration/decimals
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, shouldReduce]);

  return (
    <span
      ref={ref}
      className={cn("tabular-nums", className)}
      aria-live="polite"
      aria-atomic="true"
    >
      {decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString()}
    </span>
  );
}
