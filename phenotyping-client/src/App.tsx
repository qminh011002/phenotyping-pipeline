import "./index.css";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessingToast } from "@/components/processing/ProcessingToast";
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
      <Toaster position="bottom-right" richColors closeButton />
      <ProcessingToast />
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
          { path: "analyze", element: <AnalyzePage /> },
          { path: "analyze/upload", element: <UploadPage /> },
          { path: "analyze/processing", element: <ProcessingPage /> },
          { path: "analyze/results", element: <ResultPage /> },
          { path: "recorded", element: <RecordedPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
