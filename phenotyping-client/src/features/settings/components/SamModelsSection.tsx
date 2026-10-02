// SamModelsSection — SAM weights used to refine larvae polygons after YOLO
// detection: list, upload, activate, delete.

import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, CheckCircle2, RefreshCw, Trash2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { formatBytes, formatDateTime, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { activateSamModel, deleteSamModel, listSamModels, uploadSamModel } from '@/services/api';
import type { SamModelResponse } from '@/types/api';
import { ActiveChip, ModelList, ModelListEmpty, ModelRow } from './ModelRow';
import { Chip, FactList, GroupHeading, SettingsSection } from './SettingsSection';
import { toastAction } from '@/lib/toasts';

interface SamModelsSectionProps {
    showHeader?: boolean;
}

export function SamModelsSection({ showHeader = true }: SamModelsSectionProps = {}) {
    const queryClient = useQueryClient();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [uploading, setUploading] = useState(false);
    const [activatingFilename, setActivatingFilename] = useState<string | null>(null);
    const [deletingFilename, setDeletingFilename] = useState<string | null>(null);

    const samQuery = useQuery({
        queryKey: ['sam-models'],
        queryFn: ({ signal }) => listSamModels(signal),
    });

    const models = samQuery.data?.models ?? [];
    const activeFilename = samQuery.data?.active_filename ?? null;
    const loading = samQuery.isPending;
    const error = samQuery.error ? String(samQuery.error) : null;

    const refresh = useCallback(
        () => queryClient.invalidateQueries({ queryKey: ['sam-models'] }),
        [queryClient],
    );

    const handleUpload = useCallback(
        async (file: File) => {
            if (!file.name.toLowerCase().endsWith('.pt')) {
                toast.error('Only .pt files are accepted');
                return;
            }
            setUploading(true);
            try {
                await toastAction(uploadSamModel(file), {
                    loading: `Uploading ${file.name}…`,
                    success: (entry) => ({
                        title: 'SAM model uploaded',
                        description: `${entry.filename} (${formatBytes(entry.file_size_bytes)})`,
                    }),
                    error: 'Failed to upload SAM model',
                });
                await refresh();
            } catch {
                // Reported by toastAction.
            } finally {
                setUploading(false);
            }
        },
        [refresh],
    );

    const handleActivate = useCallback(
        async (filename: string) => {
            setActivatingFilename(filename);
            try {
                await toastAction(activateSamModel(filename), {
                    loading: 'Activating SAM model…',
                    success: {
                        title: 'SAM model activated',
                        description: `${filename} will be used on the next larvae inference.`,
                    },
                    error: 'Failed to activate SAM model',
                });
                await refresh();
            } catch {
                // Reported by toastAction.
            } finally {
                setActivatingFilename(null);
            }
        },
        [refresh],
    );

    const handleDelete = useCallback(
        async (filename: string) => {
            setDeletingFilename(filename);
            try {
                await toastAction(deleteSamModel(filename), {
                    loading: 'Deleting SAM model…',
                    success: { title: 'SAM model deleted', description: filename },
                    error: 'Failed to delete SAM model',
                });
                await refresh();
            } catch {
                // Reported by toastAction.
            } finally {
                setDeletingFilename(null);
            }
        },
        [refresh],
    );

    const renderRow = (model: SamModelResponse) => {
        const isActive = model.is_active;
        // Built-in weights and the active model can't be deleted.
        const canDelete = !model.is_builtin && !isActive;
        const deleteBlockedReason = model.is_builtin
            ? 'Built-in SAM weights cannot be deleted.'
            : isActive
              ? 'Activate another model first.'
              : undefined;

        return (
            <ModelRow
                key={model.filename}
                filename={model.filename}
                active={isActive}
                badges={
                    <>
                        <Chip tone={model.is_builtin ? 'neutral' : 'outline'}>
                            {model.is_builtin ? 'Built-in' : 'Custom'}
                        </Chip>
                        {isActive && <ActiveChip />}
                    </>
                }
                meta={
                    <>
                        <span className="tabular-nums">{formatBytes(model.file_size_bytes)}</span>
                        <span>{formatDateTime(model.uploaded_at)}</span>
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
                                onClick={() => handleActivate(model.filename)}
                                disabled={activatingFilename === model.filename}
                            >
                                <Check className="size-3.5" aria-hidden />
                                {activatingFilename === model.filename
                                    ? 'Activating…'
                                    : 'Set active'}
                            </Button>
                        )}
                        {/* The span carries the tooltip: disabled buttons ignore the pointer. */}
                        <span title={deleteBlockedReason}>
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => handleDelete(model.filename)}
                                disabled={!canDelete || deletingFilename === model.filename}
                            >
                                <Trash2 className="size-3.5" aria-hidden />
                                {deletingFilename === model.filename ? 'Deleting…' : 'Delete'}
                            </Button>
                        </span>
                    </>
                }
            />
        );
    };

    return (
        <section className="space-y-4">
            {showHeader && (
                <GroupHeading
                    eyebrow="Refinement library"
                    title="SAM models"
                    description={
                        <>
                            Manage SAM <code className="font-mono">.pt</code> weights used to refine
                            larvae polygons after YOLO detection. Upload custom checkpoints and
                            choose the active refiner.
                        </>
                    }
                    aside={
                        <FactList
                            facts={[
                                { label: 'Models', value: models.length },
                                { label: 'Format', value: '.pt' },
                                {
                                    label: 'Active',
                                    value: activeFilename ?? 'None',
                                    title: activeFilename ?? 'None',
                                },
                            ]}
                        />
                    }
                />
            )}

            <SettingsSection
                as="h3"
                layout="stacked"
                flush
                title="Polygon refinement"
                description="Refines larvae polygons after YOLO inference. The active SAM weight is loaded lazily on the next inference call."
                meta={
                    <>
                        {activeFilename ? (
                            <Chip tone="primary" title={activeFilename}>
                                Active:
                                <span className="min-w-0 truncate font-mono">{activeFilename}</span>
                            </Chip>
                        ) : (
                            <Chip tone="destructive">No active SAM model</Chip>
                        )}
                        <span className="tabular-nums">
                            {models.length} {pluralize(models.length, 'model')}
                        </span>
                    </>
                }
                actions={
                    <>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                        >
                            <Upload className="size-3.5" aria-hidden />
                            {uploading ? 'Uploading…' : 'Upload SAM model'}
                        </Button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pt"
                            className="hidden"
                            aria-label="Upload a .pt SAM model"
                            onChange={(e) => {
                                const selected = e.target.files?.[0];
                                if (selected) {
                                    void handleUpload(selected);
                                }
                                e.currentTarget.value = '';
                            }}
                        />
                    </>
                }
            >
                {loading ? (
                    <div className="space-y-3 p-5">
                        {Array.from({ length: 2 }).map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : error ? (
                    <div
                        role="alert"
                        className="flex flex-wrap items-center justify-between gap-3 p-5"
                    >
                        <p className="flex min-w-0 items-start gap-2 text-sm text-destructive">
                            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                            <span className="min-w-0 break-words">{error}</span>
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => samQuery.refetch()}
                            disabled={samQuery.isFetching}
                        >
                            <RefreshCw
                                className={cn('size-3.5', samQuery.isFetching && 'animate-spin')}
                                aria-hidden
                            />
                            Retry
                        </Button>
                    </div>
                ) : models.length === 0 ? (
                    <ModelListEmpty>
                        No SAM weights found in{' '}
                        <code className="font-mono">backend/data/models/sam/</code>. Upload a{' '}
                        <code className="font-mono">.pt</code> file to get started.
                    </ModelListEmpty>
                ) : (
                    <ModelList>{models.map(renderRow)}</ModelList>
                )}
            </SettingsSection>
        </section>
    );
}
