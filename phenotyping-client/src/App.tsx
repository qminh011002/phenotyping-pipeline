import './index.css';
import { lazy, Suspense, useEffect } from 'react';
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router-dom';

import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { RedirectIfAuthed } from '@/components/auth/RedirectIfAuthed';
import { Toaster } from '@/components/ui/sonner';
import { toast } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { recordLocation } from '@/lib/navTrail';
import { BatchTracker } from '@/features/processing/BatchTracker';
import { BootProvider } from '@/providers/BootProvider';
import { onForceLogout } from '@/services/http';
import { startStageTracker, stopStageTracker } from '@/services/stageTracker';
import { useProcessingStore } from '@/stores/processingStore';
import { Spinner } from '@/components/common/Spinner';
import HomePage from '@/pages/HomePage';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import NotFoundPage from '@/pages/NotFoundPage';

// Everything past the landing screens is split out, so the first paint does
// not pay for the canvas editor (Konva), the upload flow or the settings
// forms. Each chunk is fetched the first time its route is opened.
const AnalyzePage = lazy(() => import('@/pages/AnalyzePage'));
const UploadPage = lazy(() => import('@/pages/UploadPage'));
const ProcessingPage = lazy(() => import('@/pages/ProcessingPage'));
const ResultPage = lazy(() => import('@/pages/ResultPage'));
const RecordedPage = lazy(() => import('@/pages/RecordedPage'));
const ModelsPage = lazy(() => import('@/pages/ModelsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));

function RouteFallback() {
    return (
        <div className="grid h-full min-h-[50vh] w-full place-items-center">
            <Spinner />
        </div>
    );
}

// Root layout — wraps every page, so the batch tracker follows the operator
// to any route while an analysis is running.
function RootLayout() {
    return (
        <TooltipProvider delayDuration={300}>
            <Toaster />
            <BatchTracker />
            <Suspense fallback={<RouteFallback />}>
                <Outlet />
            </Suspense>
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

// Feed the navigation trail that back controls read (see useBackTo).
const trackLocation = (location: { pathname: string; search: string }) =>
    recordLocation(location.pathname + location.search);
trackLocation(router.state.location);
router.subscribe((state) => trackLocation(state.location));

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
