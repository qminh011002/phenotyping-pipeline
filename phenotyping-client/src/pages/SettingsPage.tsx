// SettingsPage — top-level settings page composing all setting sections.
// Route: /settings

import { ThemeSection } from "@/features/settings/components/ThemeSection";
import { ConnectionSection } from "@/features/settings/components/ConnectionSection";
import { DeviceSection } from "@/features/settings/components/DeviceSection";
import { StorageSection } from "@/features/settings/components/StorageSection";
import { LogViewer } from "@/features/logs/components/LogViewer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default function SettingsPage() {
  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          <ThemeSection />
          <Separator />
          <ConnectionSection />
          <Separator />
          <DeviceSection />
          <Separator />
          <StorageSection />
          <Separator />
          <Card>
            <CardHeader>
              <CardTitle>Log Viewer</CardTitle>
              <CardDescription>
                Live stream of backend logs. Auto-scrolls to the latest entry when enabled.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="h-96 border rounded-md overflow-hidden">
                <LogViewer />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
