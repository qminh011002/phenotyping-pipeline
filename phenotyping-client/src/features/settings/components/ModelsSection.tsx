import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, Check, CheckCircle2, Cpu, Trash2, Upload } from 'lucide-react';

import { toast } from '@/components/ui/sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
    assignModel,
    deleteCustomModel,
    getModelAssignments,
    listCustomModels,
    uploadCustomModel,
} from '@/services/api';
import type { CustomModelResponse, Organism, OrganismAssignment } from '@/types/api';

const ORGANISM_ORDER: Organism[] = ['egg', 'larvae', 'pupae', 'neonate'];

const ORGANISM_META: Record<Organism, { label: string; description: string }> = {
    egg: {
        label: 'Egg',
        description: 'Primary egg-detection weights used for egg counting workflows.',
    },
    larvae: {
        label: 'Larvae',
        description: 'Larvae-stage detection weights for larvae-specific runs.',
    },
    pupae: {
        label: 'Pupae',
        description: 'Pupae-stage detection weights for pupae-specific runs.',
    },
    neonate: {
        label: 'Neonate',
        description: 'Neonate-stage detection weights for neonate-specific runs.',
    },
};

function formatSize(bytes: number) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

interface ModelLibraryProps {
    assignment: OrganismAssignment;
    customModels: CustomModelResponse[];
    uploadingOrganism: Organism | null;
    actionKey: string | null;
    deleteKey: string | null;
    revertKey: Organism | null;
    onActivate: (organism: Organism, modelId: string) => void;
    onDelete: (modelId: string) => void;
    onRevertDefault: (organism: Organism) => void;
    onUploadFile: (organism: Organism, file: File) => void;
}

interface ModeTabProps {
    organism: Organism;
    assignment: OrganismAssignment;
    customCount: number;
    selected: boolean;
    onSelect: (organism: Organism) => void;
}

function ModeTab({ organism, assignment, customCount, selected, onSelect }: ModeTabProps) {
    const meta = ORGANISM_META[organism];
    const slotState: 'custom' | 'default' | 'missing' =
        assignment.custom_model !== null
            ? 'custom'
            : assignment.has_default
              ? 'default'
              : 'missing';
    const activeLabel =
        assignment.custom_model?.original_filename ??
        assignment.default_filename ??
        'No active model';

    return (
        <button
            type="button"
            onClick={() => onSelect(organism)}
            className={cn(
                'group relative flex min-h-36 cursor-pointer flex-col rounded-md bg-card/55 p-4 text-left shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition-[background-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:bg-card/75 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                selected &&
                    'bg-primary/12 shadow-[inset_0_0_0_1px_rgb(16_185_129/0.55),inset_0_1px_0_rgb(255_255_255/0.08)]',
            )}
        >
            {selected && (
                <div className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                    <CheckCircle2 className="size-3.5" />
                </div>
            )}

            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                    <div
                        className={cn(
                            'flex size-9 items-center justify-center rounded-md bg-muted/45 text-muted-foreground',
                            selected && 'bg-primary/15 text-primary',
                        )}
                    >
                        <Bug className="h-4 w-4" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold">{meta.label}</h3>
                        <p className="text-xs text-muted-foreground">Detection mode</p>
                    </div>
                </div>

                {slotState === 'missing' ? (
                    <Badge variant="destructive">Missing</Badge>
                ) : (
                    <Badge
                        variant={slotState === 'custom' ? 'default' : 'secondary'}
                        className={selected ? 'mr-7' : undefined}
                    >
                        {slotState === 'custom' ? 'Custom' : 'Default'}
                    </Badge>
                )}
            </div>

            <div className="mt-4 min-w-0">
                <p className="truncate font-mono text-xs text-muted-foreground" title={activeLabel}>
                    {activeLabel}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                    {customCount} custom model{customCount !== 1 ? 's' : ''}
                </p>
            </div>

            <div className="mt-auto pt-4">
                <span
                    className={cn(
                        'text-xs font-medium text-muted-foreground transition-colors',
                        selected && 'text-primary',
                    )}
                >
                    {selected ? 'Managing this mode' : 'Open mode'}
                </span>
            </div>
        </button>
    );
}

function ModelLibrary({
    assignment,
    customModels,
    uploadingOrganism,
    actionKey,
    deleteKey,
    revertKey,
    onActivate,
    onDelete,
    onRevertDefault,
    onUploadFile,
}: ModelLibraryProps) {
    const { organism, is_default, has_default, model_filename, default_filename, custom_model } =
        assignment;
    const meta = ORGANISM_META[organism];
    const activeCustomId = custom_model?.id ?? null;
    const isUploading = uploadingOrganism === organism;
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Active state for the slot header. "missing" means neither a default nor a
    // custom-active model is installed — the inference path will 503 and the
    // AnalyzePage card is disabled.
    const slotState: 'custom' | 'default' | 'missing' =
        custom_model !== null ? 'custom' : has_default ? 'default' : 'missing';

    return (
        <section className="overflow-hidden rounded-md bg-card/55 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
            <div className="flex flex-col gap-4 px-5 pt-5 pb-2">
                <div className="min-w-0 space-y-2">
                    <div className="flex items-center gap-2">
                        <div className="flex size-9 items-center justify-center rounded-md bg-muted/45 text-muted-foreground">
                            <Bug className="h-4 w-4" />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold">{meta.label} Mode</h3>
                            <p className="text-xs text-muted-foreground">{meta.description}</p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        {slotState === 'missing' ? (
                            <Badge variant="destructive">No model installed</Badge>
                        ) : (
                            <Badge variant={is_default ? 'secondary' : 'default'}>
                                {is_default ? 'Using default' : 'Custom active'}
                            </Badge>
                        )}
                        {model_filename && (
                            <span className="rounded-md bg-muted/45 px-2.5 py-1 font-mono text-muted-foreground">
                                {model_filename}
                            </span>
                        )}
                        <span className="text-muted-foreground">
                            {customModels.length} custom model{customModels.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                </div>
            </div>

            <div className="space-y-3 p-5">
                {has_default && default_filename ? (
                    <div
                        className={`flex flex-col gap-3 rounded-md p-4 sm:flex-row sm:items-center sm:justify-between ${
                            is_default ? 'bg-primary/10' : 'bg-muted/30'
                        }`}
                    >
                        <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-sm font-medium">
                                    {default_filename}
                                </span>
                                <Badge variant="secondary">Default</Badge>
                                {is_default && (
                                    <Badge variant="default" className="gap-1">
                                        <Check className="h-3 w-3" />
                                        Active
                                    </Badge>
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Loaded from{' '}
                                <code className="font-mono">
                                    backend/data/models/{organism}/default/
                                </code>
                                .
                            </p>
                        </div>

                        {is_default ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                className="gap-1.5 self-start sm:self-center"
                                disabled
                            >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Active
                            </Button>
                        ) : (
                            <Button
                                variant="default"
                                size="sm"
                                className="gap-1.5 self-start sm:self-center"
                                onClick={() => onRevertDefault(organism)}
                                disabled={revertKey === organism}
                            >
                                <Check className="h-3.5 w-3.5" />
                                {revertKey === organism ? 'Activating...' : 'Set Active'}
                            </Button>
                        )}
                    </div>
                ) : (
                    <div className="rounded-md bg-amber-500/10 p-4 text-sm">
                        <p className="font-medium text-amber-700 dark:text-amber-400">
                            No default model installed for {meta.label.toLowerCase()} mode.
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Drop a <code className="font-mono">.pt</code> file into{' '}
                            <code className="font-mono">
                                backend/data/models/{organism}/default/
                            </code>{' '}
                            and restart the backend, or upload a custom model below.
                        </p>
                    </div>
                )}

                {customModels.length === 0 ? (
                    <div className="rounded-md bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
                        No custom `.pt` files uploaded for {meta.label.toLowerCase()} yet.
                    </div>
                ) : (
                    <div className="space-y-3">
                        {customModels.map((model) => {
                            const isActive = model.id === activeCustomId;
                            const currentActionKey = `${organism}:${model.id}`;

                            return (
                                <div
                                    key={model.id}
                                    className={`flex flex-col gap-3 rounded-md p-4 sm:flex-row sm:items-center sm:justify-between ${
                                        isActive ? 'bg-primary/10' : 'bg-muted/30'
                                    }`}
                                >
                                    <div className="min-w-0 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="truncate font-mono text-sm">
                                                {model.original_filename}
                                            </span>
                                            <Badge variant="outline">Custom</Badge>
                                            {isActive && (
                                                <Badge variant="default" className="gap-1">
                                                    <Check className="h-3 w-3" />
                                                    Active
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                            <span>{formatSize(model.file_size_bytes)}</span>
                                            <span>{formatDate(model.uploaded_at)}</span>
                                        </div>
                                    </div>

                                    <div className="flex gap-2 self-start sm:self-center">
                                        {isActive ? (
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                className="gap-1.5"
                                                disabled
                                            >
                                                <CheckCircle2 className="h-3.5 w-3.5" />
                                                Active
                                            </Button>
                                        ) : (
                                            <Button
                                                variant="default"
                                                size="sm"
                                                className="gap-1.5"
                                                onClick={() => onActivate(organism, model.id)}
                                                disabled={actionKey === currentActionKey}
                                            >
                                                <Check className="h-3.5 w-3.5" />
                                                {actionKey === currentActionKey
                                                    ? 'Activating...'
                                                    : 'Set Active'}
                                            </Button>
                                        )}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="gap-1.5 text-destructive hover:text-destructive"
                                            onClick={() => onDelete(model.id)}
                                            disabled={deleteKey === model.id || isActive}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            {deleteKey === model.id ? 'Deleting...' : 'Delete'}
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                <Button
                    variant="outline"
                    className="w-full gap-2 border-dashed bg-background hover:bg-accent/30"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                >
                    <Upload className="h-4 w-4" />
                    {isUploading ? 'Uploading...' : 'Upload Model'}
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pt"
                    className="hidden"
                    onChange={(e) => {
                        const selected = e.target.files?.[0];
                        if (selected) {
                            onUploadFile(organism, selected);
                        }
                        e.currentTarget.value = '';
                    }}
                />
            </div>
        </section>
    );
}

interface ModelsSectionProps {
    showHeader?: boolean;
}

export function ModelsSection({ showHeader = true }: ModelsSectionProps = {}) {
    const queryClient = useQueryClient();
    const [uploadingOrganism, setUploadingOrganism] = useState<Organism | null>(null);
    const [actionKey, setActionKey] = useState<string | null>(null);
    const [deleteKey, setDeleteKey] = useState<string | null>(null);
    const [revertKey, setRevertKey] = useState<Organism | null>(null);
    const [selectedOrganism, setSelectedOrganism] = useState<Organism>('egg');

    const modelsQuery = useQuery({
        queryKey: ['models-section-data'],
        queryFn: async ({ signal }) => {
            const [assignData, modelsData] = await Promise.all([
                getModelAssignments(signal),
                listCustomModels(undefined, signal),
            ]);
            return {
                assignments: assignData,
                customModels: modelsData.models,
            };
        },
    });
    const assignments = modelsQuery.data?.assignments ?? null;
    const customModels = modelsQuery.data?.customModels ?? [];
    const loading = modelsQuery.isPending;
    const error = modelsQuery.error ? String(modelsQuery.error) : null;

    const refreshModelsData = useCallback(async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['models-section-data'] }),
            queryClient.invalidateQueries({ queryKey: ['model-assignments'] }),
        ]);
    }, [queryClient]);

    const fetchData = useCallback(async () => {
        await refreshModelsData();
    }, [refreshModelsData]);

    const modelsByOrganism = useMemo(() => {
        const groups: Record<Organism, CustomModelResponse[]> = {
            egg: [],
            larvae: [],
            pupae: [],
            neonate: [],
        };

        for (const model of customModels) {
            groups[model.organism].push(model);
        }

        return groups;
    }, [customModels]);

    const handleActivate = useCallback(
        async (organism: Organism, modelId: string) => {
            const key = `${organism}:${modelId}`;
            setActionKey(key);
            try {
                await assignModel(organism, modelId);
                toast.success('Model activated', {
                    description: `${ORGANISM_META[organism].label} mode now points to the selected model. Restart the backend to apply changes.`,
                });
                await fetchData();
            } catch (err) {
                toast.error('Failed to activate model', { description: String(err) });
            } finally {
                setActionKey(null);
            }
        },
        [fetchData],
    );

    const handleRevertDefault = useCallback(
        async (organism: Organism) => {
            setRevertKey(organism);
            try {
                await assignModel(organism, null);
                toast.success('Reverted to default model', {
                    description: `${ORGANISM_META[organism].label} mode will use its built-in default after backend restart.`,
                });
                await fetchData();
            } catch (err) {
                toast.error('Failed to revert model', { description: String(err) });
            } finally {
                setRevertKey(null);
            }
        },
        [fetchData],
    );

    const handleDelete = useCallback(
        async (modelId: string) => {
            setDeleteKey(modelId);
            try {
                await deleteCustomModel(modelId);
                toast.success('Model deleted');
                await fetchData();
            } catch (err) {
                toast.error('Failed to delete model', { description: String(err) });
            } finally {
                setDeleteKey(null);
            }
        },
        [fetchData],
    );

    const handleUploadFile = useCallback(
        async (organism: Organism, file: File) => {
            if (!file.name.toLowerCase().endsWith('.pt')) {
                toast.error('Only .pt files are accepted');
                return;
            }

            setUploadingOrganism(organism);
            try {
                await uploadCustomModel(organism, file);
                toast.success('Model uploaded', {
                    description: `${file.name} uploaded for ${ORGANISM_META[organism].label} mode.`,
                });
                await fetchData();
            } catch (err) {
                toast.error('Failed to upload model', { description: String(err) });
            } finally {
                setUploadingOrganism(null);
            }
        },
        [fetchData],
    );

    return (
        <section className="space-y-4">
            {showHeader && (
                <div className="space-y-1">
                    <h2 className="flex items-center gap-2 text-base font-semibold">
                        <Cpu className="h-4 w-4" />
                        Detection Models
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        Manage YOLO detection models (`.pt`) for all 4 configured modes. Each mode
                        keeps its own model library and one active model selection.
                    </p>
                </div>
            )}
            <div className="space-y-4">
                {loading ? (
                    <div className="space-y-4">
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {Array.from({ length: 4 }).map((_, i) => (
                                <Skeleton key={i} className="h-36 w-full rounded-md" />
                            ))}
                        </div>
                        <Skeleton className="h-80 w-full rounded-md" />
                    </div>
                ) : error ? (
                    <p className="text-sm text-destructive">{error}</p>
                ) : assignments ? (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {ORGANISM_ORDER.map((organism) => (
                                <ModeTab
                                    key={organism}
                                    organism={organism}
                                    assignment={assignments.assignments[organism]}
                                    customCount={modelsByOrganism[organism].length}
                                    selected={selectedOrganism === organism}
                                    onSelect={setSelectedOrganism}
                                />
                            ))}
                        </div>

                        <ModelLibrary
                            assignment={assignments.assignments[selectedOrganism]}
                            customModels={modelsByOrganism[selectedOrganism]}
                            uploadingOrganism={uploadingOrganism}
                            actionKey={actionKey}
                            deleteKey={deleteKey}
                            revertKey={revertKey}
                            onActivate={handleActivate}
                            onDelete={handleDelete}
                            onRevertDefault={handleRevertDefault}
                            onUploadFile={handleUploadFile}
                        />
                    </>
                ) : null}
            </div>
        </section>
    );
}
