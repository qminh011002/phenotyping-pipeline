// SettingsPage — top-level settings page composing all setting sections.
// Route: /settings

import { PageHeader } from '@/components/common';
import { LogViewer } from '@/features/logs/components/LogViewer';
import { DeviceSection } from '@/features/settings/components/DeviceSection';
import { SettingsSection } from '@/features/settings/components/SettingsSection';
import { ThemeSection } from '@/features/settings/components/ThemeSection';

export default function SettingsPage() {
    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-5xl px-6 py-6">
                    <PageHeader
                        eyebrow="Workspace"
                        title="Settings"
                        description="Appearance, the compute device used for inference, and the live backend log."
                    />

                    <div className="mt-6 flex flex-col gap-4">
                        <ThemeSection />
                        <DeviceSection />
                        <SettingsSection
                            layout="stacked"
                            flush
                            title="Log viewer"
                            description="Live stream of backend logs. Auto-scrolls to the latest entry when enabled."
                        >
                            <div className="h-[28rem]">
                                <LogViewer />
                            </div>
                        </SettingsSection>
                    </div>
                </div>
            </div>
        </div>
    );
}
