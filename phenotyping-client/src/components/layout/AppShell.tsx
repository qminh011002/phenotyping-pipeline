import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { MotionPage } from "@/components/motion/MotionPage";
import { useProcessingStore } from "@/stores/processingStore";
import { isManagerRunning, resumeActiveBatchIfAny } from "@/services/processingManager";

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();

  const isProcessing = useProcessingStore((s) => s.isProcessing);

  // Reconcile against the backend on first mount so the sidebar indicator
  // and any later navigation to /analyze/processing reflect reality. The
  // manager's resumeActiveBatchIfAny is idempotent and safe to call from
  // here as well as from ProcessingPage.
  useEffect(() => {
    if (isProcessing || isManagerRunning()) return;
    void resumeActiveBatchIfAny();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />
      <main className="relative flex-1 overflow-hidden">
        <AnimatePresence initial={false}>
          <MotionPage key={location.pathname}>
            <Outlet />
          </MotionPage>
        </AnimatePresence>
      </main>
    </div>
  );
}
