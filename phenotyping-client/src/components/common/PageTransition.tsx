// PageTransition — wraps page content with a subtle fade-in animation.
// Uses the CSS animation utilities defined in index.css (animate-fade-in).

import type { ReactNode } from "react";

interface PageTransitionProps {
  children: ReactNode;
  className?: string;
}

export function PageTransition({ children, className }: PageTransitionProps) {
  return (
    <div
      className={`animate-fade-in animate-in fade-in-0 fill-mode-both ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
