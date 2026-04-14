import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { listContainerVariants, listItemVariants } from "@/lib/motion";

interface MotionListProps {
  children: ReactNode;
  className?: string;
}

export function MotionList({ children, className }: MotionListProps) {
  return (
    <motion.div
      variants={listContainerVariants}
      initial="hidden"
      animate="visible"
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface MotionItemProps {
  children: ReactNode;
  className?: string;
}

export function MotionItem({ children, className }: MotionItemProps) {
  return (
    <motion.div
      variants={listItemVariants}
      className={className}
    >
      {children}
    </motion.div>
  );
}
