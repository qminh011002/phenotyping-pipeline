import "./index.css";
import { useEffect } from "react";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BootProvider } from "@/providers/BootProvider";
import { startStageTracker, stopStageTracker } from "@/services/stageTracker";
import HomePage from "@/pages/HomePage";
import AnalyzePage from "@/pages/AnalyzePage";
import UploadPage from "@/pages/UploadPage";
import ProcessingPage from "@/pages/ProcessingPage";
import ResultPage from "@/pages/ResultPage";
import RecordedPage from "@/pages/RecordedPage";
import SettingsPage from "@/pages/SettingsPage";
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";

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
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomePage /> },
          { path: "analyze/processing", element: <ProcessingPage /> },
          { path: "recorded", element: <RecordedPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
      { path: "analyze", element: <AnalyzePage /> },
      { path: "analyze/upload", element: <UploadPage /> },
      { path: "analyze/results", element: <ResultPage /> },
      { path: "login", element: <LoginPage /> },
      { path: "register", element: <RegisterPage /> },
    ],
  },
]);

export default function App() {
  useEffect(() => {
    startStageTracker();
    return () => stopStageTracker();
  }, []);
  return (
    <BootProvider>
      <RouterProvider router={router} />
    </BootProvider>
  );
}
