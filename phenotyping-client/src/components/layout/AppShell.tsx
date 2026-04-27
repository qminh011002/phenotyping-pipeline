import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { MotionPage } from "@/components/motion/MotionPage";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useProcessingStore } from "@/stores/processingStore";
import { isManagerRunning, resumeActiveBatchIfAny } from "@/services/processingManager";

const SHELL_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/recorded": "Recorded",
  "/settings": "Settings",
  "/analyze/processing": "Processing",
};

export function AppShell() {
  const location = useLocation();
  const shellTitle = SHELL_TITLES[location.pathname] ?? "Phenotyping";

  const isProcessing = useProcessingStore((s) => s.isProcessing);

  // Reconcile against the backend on first mount so the sidebar indicator
  // and any later navigation to /analyze/processing reflect reality. The
  // manager's resumeActiveBatchIfAny is idempotent and safe to call from
  // here as well as from ProcessingPage.
  useEffect(() => {
    if (isProcessing || isManagerRunning()) return;
    void resumeActiveBatchIfAny().catch((err) => {
      console.warn("resumeActiveBatchIfAny failed:", err);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      <Sidebar />
      <SidebarInset className="h-svh min-h-0 overflow-hidden bg-background md:m-2 md:h-[calc(100svh-1rem)] md:rounded-lg">
        <div className="flex h-12 shrink-0 items-center gap-2 bg-background px-3">
          <SidebarTrigger />
          <div className="h-4 w-px bg-border" />
          <div className="min-w-0 text-sm text-muted-foreground">
            {shellTitle}
          </div>
        </div>
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false}>
            <MotionPage key={location.pathname}>
              <Outlet />
            </MotionPage>
          </AnimatePresence>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
