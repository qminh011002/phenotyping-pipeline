// ModelsSection — YOLO detection weights per organism mode. Pick a mode, then
// manage its library: the built-in default, uploaded custom checkpoints, and
// which of them inference uses.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, CheckCircle2, RefreshCw, Trash2, Upload } from 'lucide-react';

import { toast } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, formatDateTime, pluralize } from '@/lib/format';
import { ORGANISM_ORDER, organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';
import {
    assignModel,
    deleteCustomModel,
    getModelAssignments,
    listCustomModels,
    uploadCustomModel,
} from '@/services/api';
import type { CustomModelResponse, Organism, OrganismAssignment } from '@/types/api';
import { ActiveChip, ModelList, ModelListEmpty, ModelListHeading, ModelRow } from './ModelRow';
import { Chip, GroupHeading, OrganismLabel, SettingsSection } from './SettingsSection';

const MODE_DESCRIPTION: Record<Organism, string> = {
    egg: 'Primary egg-detection weights used for egg counting workflows.',
    neonate: 'Neonate-stage detection weights for neonate-specific runs.',
    larvae: 'Larvae-stage detection weights for larvae-specific runs.',
    pupae: 'Pupae-stage detection weights for pupae-specific runs.',
};

type SlotState = 'custom' | 'default' | 'missing';

// "missing" means neither a default nor a custom-active model is installed —
// the inference path will 503 and the AnalyzePage card is disabled.
function slotStateOf(assignment: OrganismAssignment): SlotState {
    if (assignment.custom_model !== null) return 'custom';
    return assignment.has_default ? 'default' : 'missing';
}

function customCountLabel(count: number) {
    return `${count} custom ${pluralize(count, 'model')}`;
}

// ── Mode selector ────────────────────────────────────────────────────────────

interface ModeTabProps {
    organism: Organism;
    assignment: OrganismAssignment;
    customCount: number;
    selected: boolean;
    onSelect: (organism: Organism) => void;
}

function ModeTab({ organism, assignment, customCount, selected, onSelect }: ModeTabProps) {
    const slotState = slotStateOf(assignment);
    const activeLabel =
        assignment.custom_model?.original_filename ??
        assignment.default_filename ??
        'No active model';

    return (
        <button
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(organism)}
            className={cn(
                'panel flex min-w-0 cursor-pointer flex-col gap-3 p-4 text-left transition-colors duration-150 ease-out',
                'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                selected
                    ? 'border-primary bg-[color-mix(in_oklab,var(--primary)_6%,var(--card))]'
                    : 'hover:bg-accent',
            )}
        >
            {/* Spans throughout: a button may only contain phrasing content. */}
            <span className="flex items-start justify-between gap-3">
                <span className="block min-w-0">
                    <OrganismLabel organism={organism} className="flex text-sm font-semibold" />
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                        Detection mode
                    </span>
                </span>
                {slotState === 'missing' ? (
                    <Chip tone="destructive">Missing</Chip>
                ) : (
                    <Chip tone={slotState === 'custom' ? 'primary' : 'neutral'}>
                        {slotState === 'custom' ? 'Custom' : 'Default'}
                    </Chip>
                )}
            </span>

            <span className="block min-w-0">
                <span
                    className="block truncate font-mono text-xs text-foreground"
                    title={activeLabel}
                >
                    {activeLabel}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
                    {customCountLabel(customCount)}
                </span>
            </span>

            <span
                className={cn(
                    'mt-auto flex items-center gap-1.5 border-t border-border pt-3 text-xs font-medium',
                    selected ? 'text-primary' : 'text-muted-foreground',
                )}
            >
                {selected && <CheckCircle2 className="size-3.5" aria-hidden />}
                {selected ? 'Managing this mode' : 'Open mode'}
            </span>
        </button>
    );
}

// ── Library for the selected mode ────────────────────────────────────────────

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
    const label = organismMeta(organism).label;
    const activeCustomId = custom_model?.id ?? null;
    const isUploading = uploadingOrganism === organism;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const slotState = slotStateOf(assignment);
    const defaultFolder = `backend/data/models/${organism}/default/`;

    return (
        <SettingsSection
            as="h3"
            layout="stacked"
            flush
            title={<OrganismLabel organism={organism} suffix="mode" />}
            description={MODE_DESCRIPTION[organism]}
            meta={
                <>
                    {slotState === 'missing' ? (
                        <Chip tone="destructive">No model installed</Chip>
                    ) : (
                        <Chip tone={is_default ? 'neutral' : 'primary'}>
                            {is_default ? 'Using default' : 'Custom active'}
                        </Chip>
                    )}
                    {model_filename && (
                        <Chip tone="outline" className="font-mono" title={model_filename}>
                            <span className="min-w-0 truncate">{model_filename}</span>
                        </Chip>
                    )}
                    <span className="tabular-nums">{customCountLabel(customModels.length)}</span>
                </>
            }
            actions={
                <>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                    >
                        <Upload className="size-3.5" aria-hidden />
                        {isUploading ? 'Uploading…' : 'Upload model'}
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pt"
                        className="hidden"
                        aria-label={`Upload a .pt model for ${label.toLowerCase()} mode`}
                        onChange={(e) => {
                            const selected = e.target.files?.[0];
                            if (selected) {
                                onUploadFile(organism, selected);
                            }
                            e.currentTarget.value = '';
                        }}
                    />
                </>
            }
        >
            <ModelListHeading>Default model</ModelListHeading>
            {has_default && default_filename ? (
                <ModelList>
                    <ModelRow
                        filename={default_filename}
                        active={is_default}
                        badges={
                            <>
                                <Chip>Default</Chip>
                                {is_default && <ActiveChip />}
                            </>
                        }
                        meta={
                            <span>
                                Loaded from <code className="font-mono">{defaultFolder}</code>.
                            </span>
                        }
                        actions={
                            is_default ? (
                                <Button variant="secondary" size="sm" disabled>
                                    <CheckCircle2 className="size-3.5" aria-hidden />
                                    Active
                                </Button>
                            ) : (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onRevertDefault(organism)}
                                    disabled={revertKey === organism}
                                >
                                    <Check className="size-3.5" aria-hidden />
                                    {revertKey === organism ? 'Activating…' : 'Set active'}
                                </Button>
                            )
                        }
                    />
                </ModelList>
            ) : (
                <div className="flex items-start gap-3 px-5 py-4">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                    <div className="min-w-0">
                        <p className="text-sm font-medium">
                            No default model installed for {label.toLowerCase()} mode.
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Drop a <code className="font-mono">.pt</code> file into{' '}
                            <code className="font-mono">{defaultFolder}</code> and restart the
                            backend, or upload a custom model.
                        </p>
                    </div>
                </div>
            )}

            <ModelListHeading>Custom models</ModelListHeading>
            {customModels.length === 0 ? (
                <ModelListEmpty>
                    No custom <code className="font-mono">.pt</code> files uploaded for{' '}
                    {label.toLowerCase()} yet.
                </ModelListEmpty>
            ) : (
                <ModelList>
                    {customModels.map((model) => {
                        const isActive = model.id === activeCustomId;
                        const currentActionKey = `${organism}:${model.id}`;

                        return (
                            <ModelRow
                                key={model.id}
                                filename={model.original_filename}
                                active={isActive}
                                badges={
                                    <>
                                        <Chip tone="outline">Custom</Chip>
                                        {isActive && <ActiveChip />}
                                    </>
                                }
                                meta={
                                    <>
                                        <span className="tabular-nums">
                                            {formatBytes(model.file_size_bytes)}
                                        </span>
                                        <span>Uploaded {formatDateTime(model.uploaded_at)}</span>
                                    </>
                                }
                                actions={
                                    <>
                                        {isActive ? (
                                            <Button variant="secondary" size="sm" disabled>
                                                <CheckCircle2 className="size-3.5" aria-hidden />
                                                Active
                                            </Button>
                                        ) : (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => onActivate(organism, model.id)}
                                                disabled={actionKey === currentActionKey}
                                            >
                                                <Check className="size-3.5" aria-hidden />
                                                {actionKey === currentActionKey
                                                    ? 'Activating…'
                                                    : 'Set active'}
                                            </Button>
                                        )}
                                        {/* The span carries the tooltip: disabled buttons ignore the pointer. */}
                                        <span
                                            title={
                                                isActive
                                                    ? 'Activate another model first.'
                                                    : undefined
                                            }
                                        >
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                onClick={() => onDelete(model.id)}
                                                disabled={deleteKey === model.id || isActive}
                                            >
                                                <Trash2 className="size-3.5" aria-hidden />
                                                {deleteKey === model.id ? 'Deleting…' : 'Delete'}
                                            </Button>
                                        </span>
                                    </>
                                }
                            />
                        );
                    })}
                </ModelList>
            )}
        </SettingsSection>
    );
}

// ── Section ──────────────────────────────────────────────────────────────────

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
    const customModels = modelsQuery.data?.customModels;
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

        for (const model of customModels ?? []) {
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
                    description: `${organismMeta(organism).label} mode now points to the selected model. Restart the backend to apply changes.`,
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
                    description: `${organismMeta(organism).label} mode will use its built-in default after backend restart.`,
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
                    description: `${file.name} uploaded for ${organismMeta(organism).label} mode.`,
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
                <GroupHeading
                    title="Detection models"
                    description={
                        <>
                            Manage YOLO detection models (<code className="font-mono">.pt</code>)
                            for all {ORGANISM_ORDER.length} configured modes. Each mode keeps its
                            own model library and one active model selection.
                        </>
                    }
                />
            )}

            {loading ? (
                <div className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        {ORGANISM_ORDER.map((organism) => (
                            <Skeleton key={organism} className="h-36 w-full rounded-xl" />
                        ))}
                    </div>
                    <Skeleton className="h-80 w-full rounded-xl" />
                </div>
            ) : error ? (
                <div
                    role="alert"
                    className="panel flex flex-wrap items-center justify-between gap-3 p-5"
                >
                    <p className="flex min-w-0 items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 break-words">{error}</span>
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => modelsQuery.refetch()}
                        disabled={modelsQuery.isFetching}
                    >
                        <RefreshCw
                            className={cn('size-3.5', modelsQuery.isFetching && 'animate-spin')}
                            aria-hidden
                        />
                        Retry
                    </Button>
                </div>
            ) : assignments ? (
                <>
                    <div
                        role="group"
                        aria-label="Detection mode"
                        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
                    >
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
        </section>
    );
}
