// SettingsPage — top-level settings page composing all setting sections.
// Route: /settings

import { ThemeSection } from "@/features/settings/components/ThemeSection";
import { ConnectionSection } from "@/features/settings/components/ConnectionSection";
import { DeviceSection } from "@/features/settings/components/DeviceSection";
import { StorageSection } from "@/features/settings/components/StorageSection";
import { ModelsSection } from "@/features/settings/components/ModelsSection";
import { LogViewer } from "@/features/logs/components/LogViewer";
import { Separator } from "@/components/ui/separator";

export default function SettingsPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="w-full max-w-5xl space-y-6">
          <ThemeSection />
          <Separator />
          <ConnectionSection />
          <Separator />
          <DeviceSection />
          <Separator />
          <StorageSection />
          <Separator />
          <ModelsSection />
          <Separator />
          <section className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">Log Viewer</h2>
              <p className="text-sm text-muted-foreground">
                Live stream of backend logs. Auto-scrolls to the latest entry when enabled.
              </p>
            </div>
            <div className="h-96 overflow-hidden rounded-md border">
              <LogViewer />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
