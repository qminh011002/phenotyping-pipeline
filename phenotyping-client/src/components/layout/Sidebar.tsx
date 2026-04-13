import { NavLink } from "react-router-dom";
import { Home, Microscope, History, Settings, ChevronLeft, ChevronRight, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "@/hooks/useTheme";

const NAV_ITEMS = [
  { to: "/", icon: Home, label: "Home" },
  { to: "/analyze", icon: Microscope, label: "Analyze" },
  { to: "/recorded", icon: History, label: "Recorded" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

interface SidebarProps {
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const EXPANDED_WIDTH = "w-60";
const COLLAPSED_WIDTH = "w-14";

export function Sidebar({ collapsed = false, onCollapsedChange }: SidebarProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-card transition-all duration-200",
        collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH
      )}
    >
      {/* Header */}
      <div className="flex h-14 items-center border-b px-3">
        {!collapsed && (
          <span className="truncate text-sm font-semibold tracking-tight">Phenotyping</span>
        )}
        {collapsed && (
          <span className="mx-auto text-base font-bold tracking-tight">P</span>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground"
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
          </NavLink>
        ))}
      </nav>

      <Separator />

      {/* Theme toggle */}
      <div className="p-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn("w-full", collapsed ? "justify-center" : "justify-start")}
          onClick={toggleTheme}
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          {!collapsed && <span className="text-xs">Theme</span>}
        </Button>
      </div>

      <Separator />

      {/* Collapse toggle + version */}
      <div className="p-2 space-y-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-center"
          onClick={() => onCollapsedChange?.(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed && <span className="text-xs">Collapse</span>}
        </Button>
        {!collapsed && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground">
            v0.1.0
          </div>
        )}
      </div>
    </aside>
  );
}
