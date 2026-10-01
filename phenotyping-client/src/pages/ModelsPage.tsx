// ModelsPage — dedicated workspace for detection model management.
// Route: /models

import { PageHeader } from '@/components/common';
import { ModelsSection } from '@/features/settings/components/ModelsSection';
import { SamModelsSection } from '@/features/settings/components/SamModelsSection';
import { FactList } from '@/features/settings/components/SettingsSection';
import { ORGANISM_ORDER } from '@/lib/organism';

export default function ModelsPage() {
    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-screen-2xl px-6 py-6">
                    <PageHeader
                        eyebrow="Model library"
                        title="Models"
                        description={
                            <>
                                Manage the <code className="font-mono">.pt</code> weights inference
                                runs on: upload custom checkpoints and choose the active model for
                                each organism mode and for polygon refinement.
                            </>
                        }
                        actions={
                            <FactList
                                facts={[
                                    { label: 'Modes', value: ORGANISM_ORDER.length },
                                    { label: 'Format', value: '.pt' },
                                    { label: 'Active', value: '1 / mode' },
                                ]}
                            />
                        }
                    />

                    <div className="mt-6 flex flex-col gap-8">
                        <ModelsSection />
                        <SamModelsSection />
                    </div>
                </div>
            </div>
        </div>
    );
}
