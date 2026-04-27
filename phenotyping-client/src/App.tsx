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
import HomePage from '@/pages/HomePage';
import AnalyzePage from '@/pages/AnalyzePage';
import UploadPage from '@/pages/UploadPage';
import ProcessingPage from '@/pages/ProcessingPage';
import ResultPage from '@/pages/ResultPage';
import RecordedPage from '@/pages/RecordedPage';
import SettingsPage from '@/pages/SettingsPage';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';

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
                            { path: 'settings', element: <SettingsPage /> },
                        ],
                    },
                    { path: 'analyze', element: <AnalyzePage /> },
                    { path: 'analyze/upload', element: <UploadPage /> },
                    { path: 'analyze/results', element: <ResultPage /> },
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
        ],
    },
]);

export default function App() {
    useEffect(() => {
        startStageTracker();
        return () => stopStageTracker();
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
