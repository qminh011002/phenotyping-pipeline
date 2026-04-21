import "./index.css";
import { useEffect, useState } from "react";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { LoadingScreen } from "@/components/LoadingScreen";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import HomePage from "@/pages/HomePage";
import AnalyzePage from "@/pages/AnalyzePage";
import UploadPage from "@/pages/UploadPage";
import ProcessingPage from "@/pages/ProcessingPage";
import ResultPage from "@/pages/ResultPage";
import RecordedPage from "@/pages/RecordedPage";
import SettingsPage from "@/pages/SettingsPage";

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
          { path: "analyze/upload", element: <UploadPage /> },
          { path: "analyze/processing", element: <ProcessingPage /> },
          { path: "analyze/results", element: <ResultPage /> },
          { path: "recorded", element: <RecordedPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
      { path: "analyze", element: <AnalyzePage /> },
    ],
  },
]);

export default function App() {
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setBooting(false), 600);
    return () => window.clearTimeout(t);
  }, []);
  if (booting) return <LoadingScreen />;
  return <RouterProvider router={router} />;
}
