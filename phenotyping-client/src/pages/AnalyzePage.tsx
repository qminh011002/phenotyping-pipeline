import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useProcessingStore } from '@/stores/processingStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModeToggle } from '@/features/analyze/components/ModeToggle';
import { ProjectTypeCard } from '@/features/analyze/components/ProjectTypeCard';
import { BeforeAfterSlider } from '@/features/analyze/components/BeforeAfterSlider';

const PREVIEW_ASSETS: Partial<Record<Organism, { before: string; after: string }>> = {
    egg: {
        before: '/assets/preview/egg/before.png',
        after: '/assets/preview/egg/after.png',
    },
    larvae: {
        before: '/assets/preview/larvae/larvae_before.png',
        after: '/assets/preview/larvae/larvae_after.png',
    },
    pupae: {
        before: '/assets/preview/pupae/pupae_before.png',
        after: '/assets/preview/pupae/pupae_after.png',
    },
    neonate: {
        before: '/assets/preview/neonate/neonate_before.png',
        after: '/assets/preview/neonate/neonate_after.png',
    },
};
import { MODES, PROJECT_TYPES, type Mode, type Organism } from '@/features/analyze/constants';
import { storeProjectClasses } from '@/features/upload/lib/processingSession';
import { Camera, Upload as UploadIcon } from 'lucide-react';
import { useBoot } from '@/providers/BootProvider';
import { getModelAssignments } from '@/services/api';

export default function AnalyzePage() {
    const navigate = useNavigate();
    const isProcessing = useProcessingStore((s) => s.isProcessing);
    const setProjectNameStore = useProcessingStore((s) => s.setProjectName);
    const setOrganismStore = useProcessingStore((s) => s.setOrganism);
    const setClassesStore = useProcessingStore((s) => s.setClasses);

    const [projectName, setProjectName] = useState('');
    const [mode, setMode] = useState<Mode | null>('upload');
    const [organism, setOrganism] = useState<Organism | null>(null);
    const [showNameError, setShowNameError] = useState(false);
    const { modelsStatus } = useBoot();
    const assignmentsQuery = useQuery({
        queryKey: ['model-assignments'],
        queryFn: ({ signal }) => getModelAssignments(signal),
    });
    const installedModels = useMemo(() => {
        const next: Partial<Record<Organism, boolean>> = {};
        const assignments = assignmentsQuery.data?.assignments;
        if (!assignments) return next;
        for (const [key, assignment] of Object.entries(assignments)) {
            const organismKey = key as Organism;
            next[organismKey] = assignment.has_default || assignment.custom_model !== null;
        }
        return next;
    }, [assignmentsQuery.data]);

    useEffect(() => {
        if (isProcessing) {
            navigate('/analyze/processing', { replace: true });
        }
    }, [isProcessing, navigate]);

    // If the user had picked an organism that just became unavailable
    // (e.g. boot health refreshed), clear the selection so they can't submit.
    useEffect(() => {
        if (!organism) return;
        const status = modelsStatus[organism];
        if (status !== undefined && status !== 'loaded') {
            setOrganism(null);
        }
    }, [organism, modelsStatus]);

    const nameTrimmed = projectName.trim();
    const modeOk = mode !== null && MODES.find((m) => m.id === mode)?.available === true;
    const organismOk =
        organism !== null &&
        PROJECT_TYPES.find((p) => p.id === organism)?.available === true &&
        (modelsStatus[organism] === 'loaded' || modelsStatus[organism] === undefined);
    const canSubmit = nameTrimmed.length > 0 && modeOk && organismOk;

    function handleSubmit() {
        if (nameTrimmed.length === 0) {
            setShowNameError(true);
            return;
        }
        if (!canSubmit || !mode || !organism) return;
        // No class names anymore — keep the store + session storage clean so
        // any old values from a previous project don't leak through.
        setProjectNameStore(nameTrimmed);
        setOrganismStore(organism);
        setClassesStore([]);
        storeProjectClasses([]);
        navigate(`/analyze/upload?mode=${mode}&type=${organism}`);
    }

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-screen-2xl px-6 py-10">
                    {/* Page title */}
                    <div className="flex flex-col">
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            New analysis
                        </p>
                        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
                            Create a project
                        </h1>
                        <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
                            A project groups images analysed together under the same organism
                            type. Pick a name, capture mode, and the organism the model should
                            detect.
                        </p>
                    </div>

                    {/* Form row */}
                    <div className="mt-6 flex flex-wrap items-start gap-x-8 gap-y-4">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="project-name" className="text-xs font-medium">
                                Project name
                            </Label>
                            <Input
                                id="project-name"
                                placeholder="e.g. Neonate Batch 03"
                                value={projectName}
                                className="h-9 w-96"
                                onChange={(e) => {
                                    setProjectName(e.target.value);
                                    if (e.target.value.trim().length > 0) setShowNameError(false);
                                }}
                                aria-invalid={showNameError}
                            />
                            {showNameError && nameTrimmed.length === 0 && (
                                <span className="text-xs text-destructive">
                                    Name cannot be empty.
                                </span>
                            )}
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <Label className="text-xs font-medium">Capture mode</Label>
                            <ModeToggle value={mode} onChange={setMode} />
                        </div>
                    </div>

                    {/* Project Type + Mode preview placeholder */}
                    <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-stretch">
                        <div className="flex flex-col">
                            <div className="mb-2 flex items-baseline justify-between">
                                <Label className="text-xs font-medium">Organism</Label>
                                <span className="text-[11px] text-muted-foreground">
                                    {PROJECT_TYPES.length} available
                                </span>
                            </div>
                            <div className="flex-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                                {PROJECT_TYPES.map((t) => (
                                    <ProjectTypeCard
                                        key={t.id}
                                        type={t}
                                        selected={organism === t.id}
                                        onSelect={() => setOrganism(t.id)}
                                        modelStatus={modelsStatus[t.id]}
                                        modelInstalled={installedModels[t.id]}
                                    />
                                ))}
                            </div>
                        </div>

                        <div className="flex flex-col">
                            <div className="mb-2 flex items-baseline">
                                <Label className="text-xs font-medium">Preview</Label>
                            </div>
                            {organism && PREVIEW_ASSETS[organism] ? (
                                <BeforeAfterSlider
                                    beforeSrc={PREVIEW_ASSETS[organism].before}
                                    afterSrc={PREVIEW_ASSETS[organism].after}
                                    beforeLabel="Original"
                                    afterLabel="Detected"
                                />
                            ) : (
                                <div className="flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/20">
                                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                                        <div className="flex size-12 items-center justify-center rounded-full bg-muted/60">
                                            {mode === 'camera' ? (
                                                <Camera className="h-5 w-5" />
                                            ) : (
                                                <UploadIcon className="h-5 w-5" />
                                            )}
                                        </div>
                                        <span className="text-sm">
                                            {mode === 'camera'
                                                ? 'Camera preview will appear after creation.'
                                                : 'Upload preview will appear after creation.'}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            </div>

            {/* Fixed footer */}
            <footer className="shrink-0 border-t border-border bg-background">
                <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-end gap-2 px-6 py-3">
                    <Button variant="ghost" onClick={() => navigate('/')}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={!canSubmit}>
                        Create project
                    </Button>
                </div>
            </footer>
        </div>
    );
}
