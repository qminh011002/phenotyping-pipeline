import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

interface MotionPageProps {
    children: ReactNode;
}

export function MotionPage({ children }: MotionPageProps) {
    return (
        <motion.div
            // Every shell page owns its own scroller, so this wrapper must not
            // scroll too: absolutely positioned descendants (e.g. sr-only text)
            // escape the page scroller and would give it a second scrollbar.
            className="absolute inset-0 overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
        >
            {children}
        </motion.div>
    );
}
