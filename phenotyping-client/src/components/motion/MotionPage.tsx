import type { ReactNode } from "react";
import { motion } from "framer-motion";

interface MotionPageProps {
  children: ReactNode;
}

export function MotionPage({ children }: MotionPageProps) {
  return (
    <motion.div
      className="absolute inset-0 overflow-y-auto"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
