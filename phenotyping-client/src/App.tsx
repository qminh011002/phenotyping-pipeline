import "./index.css";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import HomePage from "@/pages/HomePage";
import AnalyzePage from "@/pages/AnalyzePage";
import RecordedPage from "@/pages/RecordedPage";
import SettingsPage from "@/pages/SettingsPage";

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "analyze", element: <AnalyzePage /> },
      { path: "recorded", element: <RecordedPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
