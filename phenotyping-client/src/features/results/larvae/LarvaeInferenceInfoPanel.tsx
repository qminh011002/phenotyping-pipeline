// Small info card shown under the measurement table — reports which models
// ran this batch and how long the inference took for this image.
//
// Model names are snapshotted at batch creation by the backend (see
// LarvaeBatchDetail.detection_model / sam_model). For legacy batches the
// snapshot is null, in which case we fall back to whatever is currently
// active so the row isn't blank — clearly marked as "(active)".

import { useQuery } from '@tanstack/react-query';
import { Clock, Cpu, Sparkles } from 'lucide-react';

import { getModelAssignments, listSamModels } from '@/services/api';

interface LarvaeInferenceInfoPanelProps {
    /** Detection model filename snapshotted at batch creation; null on legacy batches. */
    detectionModel: string | null;
    /** SAM model filename snapshotted at batch creation; null on legacy batches. */
    samModel: string | null;
    /** Per-image inference wall time (null on legacy batches). */
    elapsedSecs: number | null;
}

function formatElapsed(seconds: number | null): string {
    if (seconds === null) return '—';
    if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
    if (seconds < 60) return `${seconds.toFixed(2)} s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
}

export function LarvaeInferenceInfoPanel({
    detectionModel,
    samModel,
    elapsedSecs,
}: LarvaeInferenceInfoPanelProps) {
    // Only query live assignments when the batch didn't snapshot them.
    const needsFallback = detectionModel === null || samModel === null;
    const assignmentsQuery = useQuery({
        queryKey: ['model-assignments'],
        queryFn: ({ signal }) => getModelAssignments(signal),
        staleTime: 60_000,
        enabled: needsFallback && detectionModel === null,
    });
    const samQuery = useQuery({
        queryKey: ['sam-models'],
        queryFn: ({ signal }) => listSamModels(signal),
        staleTime: 60_000,
        enabled: needsFallback && samModel === null,
    });

    const detectionFallback = assignmentsQuery.data?.assignments.larvae?.model_filename ?? null;
    const samFallback = samQuery.data?.active_filename ?? null;

    const detectionName = detectionModel ?? detectionFallback ?? '—';
    const detectionIsLive = detectionModel === null && detectionFallback !== null;
    const samName = samModel ?? samFallback ?? '—';
    const samIsLive = samModel === null && samFallback !== null;

    return (
        <section
            className="space-y-2 rounded-md bg-card/55 p-3 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]"
            data-testid="larvae-inference-info"
        >
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Inference info
            </p>
            <dl className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-1.5 text-muted-foreground">
                        <Cpu className="h-3.5 w-3.5" />
                        Detection model
                    </dt>
                    <dd
                        className="flex items-center gap-1.5 truncate font-mono text-foreground/90"
                        title={detectionName}
                    >
                        <span className="truncate">{detectionName}</span>
                        {detectionIsLive && (
                            <span className="text-[10px] uppercase text-muted-foreground">
                                (active)
                            </span>
                        )}
                    </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-1.5 text-muted-foreground">
                        <Sparkles className="h-3.5 w-3.5" />
                        SAM model
                    </dt>
                    <dd
                        className="flex items-center gap-1.5 truncate font-mono text-foreground/90"
                        title={samName}
                    >
                        <span className="truncate">{samName}</span>
                        {samIsLive && (
                            <span className="text-[10px] uppercase text-muted-foreground">
                                (active)
                            </span>
                        )}
                    </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Processing time
                    </dt>
                    <dd className="tabular-nums font-medium text-foreground/90">
                        {formatElapsed(elapsedSecs)}
                    </dd>
                </div>
            </dl>
        </section>
    );
}
