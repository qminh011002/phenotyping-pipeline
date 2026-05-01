import { QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';

import { queryClient } from '@/lib/queryClient';
import { ThemeProvider } from './ThemeProvider';

interface AppProvidersProps {
    children: React.ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
    return (
        <QueryClientProvider client={queryClient}>
            <MotionConfig reducedMotion="user">
                <ThemeProvider>{children}</ThemeProvider>
            </MotionConfig>
        </QueryClientProvider>
    );
}
