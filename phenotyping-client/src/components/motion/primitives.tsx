import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { fadeVariants, slideUpVariants, zoomVariants } from "@/lib/motion";

interface FadeInProps {
  children: ReactNode;
  delay?: number;
  className?: string;
}

export function FadeIn({ children, delay = 0, className }: FadeInProps) {
  return (
    <motion.div
      variants={fadeVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface SlideUpProps {
  children: ReactNode;
  delay?: number;
  className?: string;
}

export function SlideUp({ children, delay = 0, className }: SlideUpProps) {
  return (
    <motion.div
      variants={slideUpVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface ZoomInProps {
  children: ReactNode;
  delay?: number;
  className?: string;
}

export function ZoomIn({ children, delay = 0, className }: ZoomInProps) {
  return (
    <motion.div
      variants={zoomVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
