import './index.css';
import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router-dom';

import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { RedirectIfAuthed } from '@/components/auth/RedirectIfAuthed';
import { Toaster } from '@/components/ui/sonner';
import { toast } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BootProvider } from '@/providers/BootProvider';
import { onForceLogout } from '@/services/http';
import { startStageTracker, stopStageTracker } from '@/services/stageTracker';
import { useProcessingStore } from '@/stores/processingStore';
import HomePage from '@/pages/HomePage';
import AnalyzePage from '@/pages/AnalyzePage';
import UploadPage from '@/pages/UploadPage';
import ProcessingPage from '@/pages/ProcessingPage';
import ResultPage from '@/pages/ResultPage';
import RecordedPage from '@/pages/RecordedPage';
import ModelsPage from '@/pages/ModelsPage';
import SettingsPage from '@/pages/SettingsPage';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import NotFoundPage from '@/pages/NotFoundPage';

// Root layout — wraps every page so ProcessingToast is always in router context
function RootLayout() {
    return (
        <TooltipProvider delayDuration={300}>
            <Toaster />
            <Outlet />
        </TooltipProvider>
    );
}

const router = createBrowserRouter([
    {
        element: <RootLayout />,
        children: [
            // Authed routes — RequireAuth bounces to /login when status != "authed".
            {
                element: <RequireAuth />,
                children: [
                    {
                        element: <AppShell />,
                        children: [
                            { index: true, element: <HomePage /> },
                            { path: 'analyze/processing', element: <ProcessingPage /> },
                            { path: 'recorded', element: <RecordedPage /> },
                            { path: 'models', element: <ModelsPage /> },
                            { path: 'settings', element: <SettingsPage /> },
                        ],
                    },
                    { path: 'analyze', element: <AnalyzePage /> },
                    { path: 'analyze/upload', element: <UploadPage /> },
                    // Result viewer — pure path params for batch + image identifiers.
                    // Three forms accepted; the component handles missing segments
                    // by redirecting to the canonical `/.../<batchId>/images/<firstId>`
                    // URL or back to home if no session is available.
                    { path: 'analyze/results', element: <ResultPage /> },
                    { path: 'analyze/results/:batchId', element: <ResultPage /> },
                    {
                        path: 'analyze/results/:batchId/images/:imageId',
                        element: <ResultPage />,
                    },
                ],
            },
            // Anon-only routes — already-authed users get redirected away.
            {
                element: <RedirectIfAuthed />,
                children: [
                    { path: 'login', element: <LoginPage /> },
                    { path: 'register', element: <RegisterPage /> },
                ],
            },
            // Catch-all 404 — must be last to let real routes match first.
            { path: '*', element: <NotFoundPage /> },
        ],
    },
]);

export default function App() {
    useEffect(() => {
        if (useProcessingStore.getState().isProcessing) {
            startStageTracker();
        }
        const unsubscribe = useProcessingStore.subscribe((state, prevState) => {
            if (state.isProcessing === prevState.isProcessing) return;
            if (state.isProcessing) {
                startStageTracker();
            } else {
                stopStageTracker();
            }
        });
        return () => {
            unsubscribe();
            stopStageTracker();
        };
    }, []);

    // Listen for forced logouts (revoked refresh, etc.) and surface a toast.
    // Navigation happens automatically via RequireAuth once the store flips.
    useEffect(() => {
        const off = onForceLogout(() => {
            toast.error('Session expired', {
                description: 'Please sign in again.',
            });
        });
        return off;
    }, []);

    return (
        <BootProvider>
            <RouterProvider router={router} />
        </BootProvider>
    );
}
