import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { pageVariants } from "@/lib/motion";

interface MotionPageProps {
  children: ReactNode;
}

export function MotionPage({ children }: MotionPageProps) {
  return (
    <motion.div
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}
