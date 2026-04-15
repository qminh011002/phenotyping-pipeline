import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { MotionPage } from "@/components/motion/MotionPage";

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();

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
