// ModelsPage — dedicated workspace for detection model management.
// Route: /models

import { CheckCircle2, Cpu, Database, Upload } from 'lucide-react';

import { ModelsSection } from '@/features/settings/components/ModelsSection';

export default function ModelsPage() {
    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-screen-2xl space-y-5 p-6">
                    <section className="rounded-md bg-card/55 p-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                            <div className="flex min-w-0 items-center gap-4">
                                <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                                    <Cpu className="size-6" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-primary">
                                        Model library
                                    </p>
                                    <h1 className="mt-1 text-2xl font-semibold tracking-normal">
                                        Detection Models
                                    </h1>
                                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                                        Manage YOLO `.pt` weights for each organism mode, upload
                                        custom checkpoints, and choose the active model for
                                        inference.
                                    </p>
                                </div>
                            </div>

                            <div className="grid gap-2 sm:grid-cols-3 lg:w-[28rem]">
                                <div className="rounded-md bg-muted/35 px-3 py-2">
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Database className="size-3.5 text-primary" />
                                        Modes
                                    </div>
                                    <p className="mt-1 text-lg font-semibold tabular-nums">4</p>
                                </div>
                                <div className="rounded-md bg-muted/35 px-3 py-2">
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Upload className="size-3.5 text-primary" />
                                        Format
                                    </div>
                                    <p className="mt-1 text-lg font-semibold">.pt</p>
                                </div>
                                <div className="rounded-md bg-muted/35 px-3 py-2">
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <CheckCircle2 className="size-3.5 text-primary" />
                                        Active
                                    </div>
                                    <p className="mt-1 text-lg font-semibold">1 / mode</p>
                                </div>
                            </div>
                        </div>
                    </section>

                    <ModelsSection showHeader={false} />
                </div>
            </div>
        </div>
    );
}
