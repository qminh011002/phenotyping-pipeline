// ThemeSection — appearance settings with light/dark toggle.
// Uses the useTheme() hook from the theme provider.

import { useTheme } from "@/hooks/useTheme";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Moon, Sun } from "lucide-react";

export function ThemeSection() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Customize how the app looks on your device.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between">
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
      </CardContent>
    </Card>
  );
}
