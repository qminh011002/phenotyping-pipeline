import { Variants, useReducedMotion as useFramerReducedMotion } from "framer-motion";

/* ═══════════════════════════════════════════════════════════════════════════
   Duration Scale — single source of truth
   ═══════════════════════════════════════════════════════════════════════════ */
export const DURATION = {
  instant: 0,
  fast: 0.15,
  base: 0.2,
  medium: 0.3,
  slow: 0.5,
} as const;

export type DurationKey = keyof typeof DURATION;

/* ═══════════════════════════════════════════════════════════════════════════
   Easing Scale — shadcn / iOS / Vercel style
   Default for entrances: EASE.out
   Default for exits:    EASE.in
   Never use linear.
   ═══════════════════════════════════════════════════════════════════════════ */
export const EASE = {
  out:      [0.32, 0.72, 0, 1] as const,
  in:       [0.64, 0, 0.78, 0] as const,
  inOut:    [0.65, 0, 0.35, 1] as const,
  standard: [0.4, 0, 0.2, 1]   as const,
} as const;

export type EaseKey = keyof typeof EASE;

/* ═══════════════════════════════════════════════════════════════════════════
   Shared Variants — used throughout the app
   ═══════════════════════════════════════════════════════════════════════════ */
export const fadeVariants: Variants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DURATION.base, ease: EASE.out } },
  exit:    { opacity: 0, transition: { duration: DURATION.fast, ease: EASE.in } },
};

export const slideUpVariants: Variants = {
  hidden:  { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE.out } },
  exit:    { opacity: 0, y: 4, transition: { duration: DURATION.fast, ease: EASE.in } },
};

export const zoomVariants: Variants = {
  hidden:  { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { duration: DURATION.base, ease: EASE.out } },
  exit:    { opacity: 0, scale: 0.96, transition: { duration: DURATION.fast, ease: EASE.in } },
};

export const listContainerVariants: Variants = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

export const listItemVariants: Variants = {
  hidden:  { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE.out } },
};

export const pageVariants: Variants = {
  hidden:  { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.medium, ease: EASE.out } },
  exit:    { opacity: 0, y: -4, transition: { duration: DURATION.fast, ease: EASE.in } },
};

/* ═══════════════════════════════════════════════════════════════════════════
   Reduced-Motion Hook
   Returns true when the OS/browser has prefers-reduced-motion: reduce.
   Consumers should fall back to fadeVariants only (no translate/scale).
   ═══════════════════════════════════════════════════════════════════════════ */
export function useReducedMotionSafe(): boolean {
  return Boolean(useFramerReducedMotion());
}
