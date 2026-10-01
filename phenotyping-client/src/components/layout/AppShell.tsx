import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, MotionConfig } from 'framer-motion';
import { Suspense, useEffect } from 'react';
import { Moon, Sun } from 'lucide-react';

import { Spinner } from '@/components/common/Spinner';

import { Sidebar } from './Sidebar';
import { MotionPage } from '@/components/motion/MotionPage';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useTheme } from '@/hooks/useTheme';
import { useProcessingStore } from '@/stores/processingStore';
import { isManagerRunning, resumeActiveBatchIfAny } from '@/services/processingManager';

const SHELL_TITLES: Record<string, string> = {
    '/': 'Dashboard',
    '/recorded': 'Recorded',
    '/models': 'Models',
    '/settings': 'Settings',
    '/analyze/processing': 'Processing',
};

export function AppShell() {
    const location = useLocation();
    const shellTitle = SHELL_TITLES[location.pathname] ?? 'Phenotyping';
    const { theme, toggleTheme } = useTheme();
    const ThemeIcon = theme === 'light' ? Moon : Sun;

    const isProcessing = useProcessingStore((s) => s.isProcessing);

    // Reconcile against the backend on first mount so the sidebar indicator
    // and any later navigation to /analyze/processing reflect reality. The
    // manager's resumeActiveBatchIfAny is idempotent and safe to call from
    // here as well as from ProcessingPage.
    useEffect(() => {
        if (isProcessing || isManagerRunning()) return;
        void resumeActiveBatchIfAny().catch((err) => {
            console.warn('resumeActiveBatchIfAny failed:', err);
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <SidebarProvider className="h-svh min-h-0 overflow-hidden">
            <Sidebar />
            <SidebarInset className="h-svh min-h-0 overflow-hidden bg-background md:m-2 md:h-[calc(100svh-1rem)] md:rounded-xl md:border md:border-border">
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3">
                    <SidebarTrigger />
                    <div className="h-4 w-px bg-border" />
                    <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {shellTitle}
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleTheme}
                        aria-label={
                            theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'
                        }
                        title={theme === 'light' ? 'Dark mode' : 'Light mode'}
                        className="text-muted-foreground"
                    >
                        <ThemeIcon />
                    </Button>
                </div>
                <MotionConfig reducedMotion="user">
                    <main className="relative min-h-0 flex-1 overflow-hidden">
                        <AnimatePresence initial={false}>
                            <MotionPage key={location.pathname}>
                                {/* Keeps the shell on screen while a page chunk loads. */}
                                <Suspense
                                    fallback={
                                        <div className="grid h-full place-items-center">
                                            <Spinner />
                                        </div>
                                    }
                                >
                                    <Outlet />
                                </Suspense>
                            </MotionPage>
                        </AnimatePresence>
                    </main>
                </MotionConfig>
            </SidebarInset>
        </SidebarProvider>
    );
}
