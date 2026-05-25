import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Database, Sparkles, Trash2, Upload } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import {
    activateSamModel,
    deleteSamModel,
    listSamModels,
    uploadSamModel,
} from '@/services/api';
import type { SamModelResponse } from '@/types/api';

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
                const entry = await uploadSamModel(file);
                toast.success('SAM model uploaded', {
                    description: `${entry.filename} (${formatSize(entry.file_size_bytes)})`,
                });
                await refresh();
            } catch (err) {
                toast.error('Failed to upload SAM model', { description: String(err) });
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
                await activateSamModel(filename);
                toast.success('SAM model activated', {
                    description: `${filename} will be used on the next larvae inference.`,
                });
                await refresh();
            } catch (err) {
                toast.error('Failed to activate SAM model', { description: String(err) });
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
                await deleteSamModel(filename);
                toast.success('SAM model deleted', { description: filename });
                await refresh();
            } catch (err) {
                toast.error('Failed to delete SAM model', { description: String(err) });
            } finally {
                setDeletingFilename(null);
            }
        },
        [refresh],
    );

    const renderRow = (model: SamModelResponse) => {
        const isActive = model.is_active;
        const canDelete = !model.is_builtin && !isActive;
        return (
            <div
                key={model.filename}
                className={`flex flex-col gap-3 rounded-md p-4 sm:flex-row sm:items-center sm:justify-between ${
                    isActive ? 'bg-primary/10' : 'bg-muted/30'
                }`}
            >
                <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm">{model.filename}</span>
                        <Badge variant={model.is_builtin ? 'secondary' : 'outline'}>
                            {model.is_builtin ? 'Builtin' : 'Custom'}
                        </Badge>
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
                        <Button variant="secondary" size="sm" className="gap-1.5" disabled>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Active
                        </Button>
                    ) : (
                        <Button
                            variant="default"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => handleActivate(model.filename)}
                            disabled={activatingFilename === model.filename}
                        >
                            <Check className="h-3.5 w-3.5" />
                            {activatingFilename === model.filename
                                ? 'Activating...'
                                : 'Set Active'}
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(model.filename)}
                        disabled={!canDelete || deletingFilename === model.filename}
                        title={
                            model.is_builtin
                                ? 'Builtin SAM weights cannot be deleted.'
                                : isActive
                                  ? 'Activate another model first.'
                                  : undefined
                        }
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        {deletingFilename === model.filename ? 'Deleting...' : 'Delete'}
                    </Button>
                </div>
            </div>
        );
    };

    return (
        <section className="space-y-4">
            {showHeader && (
                <section className="rounded-md bg-card/55 p-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex min-w-0 items-center gap-4">
                            <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                                <Sparkles className="size-6" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-primary">
                                    Refinement library
                                </p>
                                <h1 className="mt-1 text-2xl font-semibold tracking-normal">
                                    SAM Models
                                </h1>
                                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                                    Manage SAM `.pt` weights used to refine larvae polygons
                                    after YOLO detection. Upload custom checkpoints and choose
                                    the active refiner.
                                </p>
                            </div>
                        </div>

                        <div className="grid gap-2 sm:grid-cols-3 lg:w-[28rem]">
                            <div className="rounded-md bg-muted/35 px-3 py-2">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Database className="size-3.5 text-primary" />
                                    Models
                                </div>
                                <p className="mt-1 text-lg font-semibold tabular-nums">
                                    {models.length}
                                </p>
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
                                <p
                                    className="mt-1 truncate text-lg font-semibold"
                                    title={activeFilename ?? 'None'}
                                >
                                    {activeFilename ?? 'None'}
                                </p>
                            </div>
                        </div>
                    </div>
                </section>
            )}

            <section className="overflow-hidden rounded-md bg-card/55 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                <div className="flex flex-col gap-4 px-5 pt-5 pb-2">
                    <div className="flex items-center gap-2">
                        <div className="flex size-9 items-center justify-center rounded-md bg-muted/45 text-muted-foreground">
                            <Sparkles className="h-4 w-4" />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold">Polygon Refinement</h3>
                            <p className="text-xs text-muted-foreground">
                                Refines larvae polygons after YOLO inference. The active SAM
                                weight is loaded lazily on the next inference call.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        {activeFilename ? (
                            <Badge variant="default">Active: {activeFilename}</Badge>
                        ) : (
                            <Badge variant="destructive">No active SAM model</Badge>
                        )}
                        <span className="text-muted-foreground">
                            {models.length} model{models.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                </div>

                <div className="space-y-3 p-5">
                    {loading ? (
                        <div className="space-y-3">
                            {Array.from({ length: 2 }).map((_, i) => (
                                <Skeleton key={i} className="h-16 w-full rounded-md" />
                            ))}
                        </div>
                    ) : error ? (
                        <p className="text-sm text-destructive">{error}</p>
                    ) : models.length === 0 ? (
                        <div className="rounded-md bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
                            No SAM weights found in{' '}
                            <code className="font-mono">backend/data/models/sam/</code>. Upload a
                            `.pt` below to get started.
                        </div>
                    ) : (
                        <div className="space-y-3">{models.map(renderRow)}</div>
                    )}

                    <Button
                        variant="outline"
                        className="w-full gap-2 border-dashed bg-background hover:bg-accent/30"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                    >
                        <Upload className="h-4 w-4" />
                        {uploading ? 'Uploading...' : 'Upload SAM Model'}
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pt"
                        className="hidden"
                        onChange={(e) => {
                            const selected = e.target.files?.[0];
                            if (selected) {
                                void handleUpload(selected);
                            }
                            e.currentTarget.value = '';
                        }}
                    />
                </div>
            </section>
        </section>
    );
}
