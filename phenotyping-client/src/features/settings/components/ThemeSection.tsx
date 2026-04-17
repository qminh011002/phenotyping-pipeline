// ThemeSection — appearance settings with light/dark toggle.
// Uses the useTheme() hook from the theme provider.

import { useTheme } from "@/hooks/useTheme";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Moon, Sun } from "lucide-react";

export function ThemeSection() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Appearance</h2>
        <p className="text-sm text-muted-foreground">Customize how the app looks on your device.</p>
      </div>
      <div className="flex items-center justify-between rounded-md border px-4 py-3">
        <div className="flex items-center gap-3">
          {isDark ? (
            <Moon className="h-5 w-5 text-muted-foreground" />
          ) : (
            <Sun className="h-5 w-5 text-muted-foreground" />
          )}
          <div>
            <Label htmlFor="theme-toggle" className="font-medium cursor-pointer">
              {isDark ? "Dark mode" : "Light mode"}
            </Label>
            <p className="text-sm text-muted-foreground">
              {isDark ? "Switch to light theme" : "Switch to dark theme"}
            </p>
          </div>
        </div>
        <Switch
          id="theme-toggle"
          checked={isDark}
          onCheckedChange={toggleTheme}
        />
      </div>
    </section>
  );
}
