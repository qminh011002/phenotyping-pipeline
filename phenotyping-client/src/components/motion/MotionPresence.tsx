import type { ReactNode } from "react";
import { AnimatePresence } from "framer-motion";

interface MotionPresenceProps {
  children: ReactNode;
  mode?: "wait" | "popLayout" | "sync";
}

export function MotionPresence({ children, mode = "wait" }: MotionPresenceProps) {
  return (
    <AnimatePresence mode={mode}>
      {children}
    </AnimatePresence>
  );
}
