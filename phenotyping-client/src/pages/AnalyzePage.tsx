import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProcessingStore } from '@/stores/processingStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModeToggle } from '@/features/analyze/components/ModeToggle';
import { ProjectTypeCard } from '@/features/analyze/components/ProjectTypeCard';
import { MODES, PROJECT_TYPES, type Mode, type Organism } from '@/features/analyze/constants';
import { storeProjectClasses } from '@/features/upload/lib/processingSession';
import { Camera, Upload as UploadIcon } from 'lucide-react';

export default function AnalyzePage() {
    const navigate = useNavigate();
    const isProcessing = useProcessingStore((s) => s.isProcessing);
    const setProjectNameStore = useProcessingStore((s) => s.setProjectName);
    const setClassesStore = useProcessingStore((s) => s.setClasses);

    const [projectName, setProjectName] = useState('');
    const [mode, setMode] = useState<Mode | null>('upload');
    const [organism, setOrganism] = useState<Organism | null>(null);
    const [showNameError, setShowNameError] = useState(false);
    const [className, setClassName] = useState('');
    // Tracks whether the user manually edited the class name — if they did,
    // stop auto-syncing it to the selected organism label.
    const [classNameEdited, setClassNameEdited] = useState(false);

    useEffect(() => {
        if (isProcessing) {
            navigate('/analyze/processing', { replace: true });
        }
    }, [isProcessing, navigate]);

    // Auto-suggest class name from the selected organism label unless the user
    // has typed their own value.
    useEffect(() => {
        if (classNameEdited) return;
        if (!organism) return;
        const suggested = PROJECT_TYPES.find((p) => p.id === organism)?.label ?? '';
        setClassName(suggested);
    }, [organism, classNameEdited]);

    const nameTrimmed = projectName.trim();
    const classNameTrimmed = className.trim();
    const modeOk = mode !== null && MODES.find((m) => m.id === mode)?.available === true;
    const organismOk =
        organism !== null && PROJECT_TYPES.find((p) => p.id === organism)?.available === true;
    const canSubmit = nameTrimmed.length > 0 && modeOk && organismOk && classNameTrimmed.length > 0;

    function handleSubmit() {
        if (nameTrimmed.length === 0) {
            setShowNameError(true);
            return;
        }
        if (!canSubmit || !mode || !organism) return;
        const classes = [classNameTrimmed];
        setProjectNameStore(nameTrimmed);
        setClassesStore(classes);
        storeProjectClasses(classes);
        navigate(`/analyze/upload?mode=${mode}&type=${organism}`);
    }

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
            {/* Fixed header */}
            <header className="shrink-0 border-b bg-background">
                <div className="mx-auto w-full max-w-7xl px-6 py-6"></div>
            </header>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-screen-2xl px-6 py-8">
                    {/* Top form row */}
                    <div className="flex flex-col">
                        <h1 className="text-3xl font-semibold tracking-tight">
                            Let's create your project.
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            A project groups many images analysed together under the same organism
                            type.
                        </p>
                    </div>
                    <div className="mt-5 flex flex-wrap items-start gap-x-8 gap-y-4">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="project-name">Project Name</Label>
                            <Input
                                id="project-name"
                                placeholder="E.g., 'Neonate Batch 03' or 'Egg Tray A'"
                                value={projectName}
                                className="w-96"
                                onChange={(e) => {
                                    setProjectName(e.target.value);
                                    if (e.target.value.trim().length > 0) setShowNameError(false);
                                }}
                                aria-invalid={showNameError}
                            />
                            {showNameError && nameTrimmed.length === 0 && (
                                <span className="text-sm text-destructive">
                                    Name cannot be empty.
                                </span>
                            )}
                        </div>

                        <div className="flex flex-col gap-2">
                            <Label>Mode</Label>
                            <ModeToggle value={mode} onChange={setMode} />
                        </div>

                        <div className="flex flex-col gap-2">
                            <Label htmlFor="class-name">Class Name</Label>
                            <Input
                                id="class-name"
                                placeholder={
                                    organism
                                        ? `E.g., '${PROJECT_TYPES.find((p) => p.id === organism)?.label ?? ''}'`
                                        : 'Pick a project type for a suggestion'
                                }
                                value={className}
                                className="w-72"
                                onChange={(e) => {
                                    setClassName(e.target.value);
                                    setClassNameEdited(true);
                                }}
                            />
                            <span className="text-xs text-muted-foreground">
                                Each project has a single class. We'll suggest one based on your
                                project type.
                            </span>
                        </div>
                    </div>

                    {/* Project Type + Mode preview placeholder */}
                    <section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-[55fr_45fr] lg:items-stretch">
                        <div className="flex flex-col">
                            <Label className="text-base">Project Type</Label>
                            <div className="mt-3 flex-1 divide-y divide-border overflow-hidden rounded-lg border border-border">
                                {PROJECT_TYPES.map((t, i) => (
                                    <ProjectTypeCard
                                        key={t.id}
                                        type={t}
                                        selected={organism === t.id}
                                        onSelect={() => setOrganism(t.id)}
                                        isFirst={i === 0}
                                        isLast={i === PROJECT_TYPES.length - 1}
                                    />
                                ))}
                            </div>
                        </div>

                        <div className="flex flex-col">
                            {/* Spacer to align with the Project Type label row */}
                            <div className="invisible" aria-hidden>
                                <Label className="text-base">Preview</Label>
                            </div>
                            <div className="mt-3 flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/30">
                                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                                    {mode === 'camera' ? (
                                        <Camera className="h-10 w-10" />
                                    ) : (
                                        <UploadIcon className="h-10 w-10" />
                                    )}
                                    <span className="text-sm">
                                        {mode === 'camera'
                                            ? 'Camera preview placeholder'
                                            : 'Upload preview placeholder'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            </div>

            {/* Fixed footer */}
            <footer className="shrink-0 border-t bg-background">
                <div className="mx-auto flex w-full max-w-7xl items-center justify-center gap-3 px-6 py-4">
                    <Button variant="ghost" onClick={() => navigate('/')}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={!canSubmit}>
                        Create Project
                    </Button>
                </div>
            </footer>
        </div>
    );
}
