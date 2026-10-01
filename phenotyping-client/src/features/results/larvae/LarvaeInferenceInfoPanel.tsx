// Small info card shown under the measurement table — reports which models
// ran this batch and how long the inference took for this image.
//
// Model names are snapshotted at batch creation by the backend (see
// LarvaeBatchDetail.detection_model / sam_model). For legacy batches the
// snapshot is null, in which case we fall back to whatever is currently
// active so the row isn't blank — clearly marked as "(active)".

import { useQuery } from '@tanstack/react-query';
import { Clock, Cpu, Ruler, ScanLine, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { getModelAssignments, listSamModels } from '@/services/api';
import { cn } from '@/lib/utils';

import type { CalibrationCorners, Organism } from '@/types/api';

import { calibrationUsable } from './measureFlow';

interface LarvaeInferenceInfoPanelProps {
    organism: Organism;
    /** Detection model filename snapshotted at batch creation; null on legacy batches. */
    detectionModel: string | null;
    /** SAM model filename snapshotted at batch creation; null on legacy batches. */
    samModel: string | null;
    /** Per-image inference wall time (null on legacy batches). */
    elapsedSecs: number | null;
    /** Batch was processed count-only (SAM and measuring skipped at inference). */
    countOnly: boolean;
    /** SAM has refined this image's outlines. */
    samRefined: boolean;
}

function formatElapsed(seconds: number | null): string {
    if (seconds === null) return '—';
    if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
    if (seconds < 60) return `${seconds.toFixed(2)} s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
}

function Row({
    icon: Icon,
    label,
    children,
    title,
}: {
    icon: React.ElementType;
    label: string;
    children: React.ReactNode;
    title?: string;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <dt className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                <Icon className="size-3.5" aria-hidden />
                {label}
            </dt>
            <dd className="flex min-w-0 items-center gap-1.5 text-foreground" title={title}>
                {children}
            </dd>
        </div>
    );
}

export function LarvaeInferenceInfoPanel({
    organism,
    detectionModel,
    samModel,
    elapsedSecs,
    countOnly,
    samRefined,
}: LarvaeInferenceInfoPanelProps) {
    // Only query live assignments when the batch didn't snapshot them.
    const assignmentsQuery = useQuery({
        queryKey: ['model-assignments'],
        queryFn: ({ signal }) => getModelAssignments(signal),
        staleTime: 60_000,
        enabled: detectionModel === null,
    });
    const samQuery = useQuery({
        queryKey: ['sam-models'],
        queryFn: ({ signal }) => listSamModels(signal),
        staleTime: 60_000,
        enabled: samModel === null,
    });

    const detectionFallback = assignmentsQuery.data?.assignments[organism]?.model_filename ?? null;
    const samFallback = samQuery.data?.active_filename ?? null;

    const detectionName = detectionModel ?? detectionFallback ?? '—';
    const detectionIsLive = detectionModel === null && detectionFallback !== null;
    const samName = samModel ?? samFallback ?? '—';
    const samIsLive = samModel === null && samFallback !== null;

    return (
        <section data-testid="larvae-inference-info">
            <h3 className="eyebrow mb-2">Inference</h3>
            <dl className="space-y-2 text-xs">
                <Row icon={ScanLine} label="Mode">
                    <span className="font-medium">
                        {countOnly ? 'Count only' : 'Count and measure'}
                    </span>
                </Row>
                <Row icon={Cpu} label="Detection model" title={detectionName}>
                    <span className="truncate font-mono">{detectionName}</span>
                    {detectionIsLive && (
                        <span className="text-[10px] text-muted-foreground uppercase">
                            (active)
                        </span>
                    )}
                </Row>
                <Row icon={Sparkles} label="SAM model" title={samName}>
                    <span className="truncate font-mono">{samName}</span>
                    {samIsLive && (
                        <span className="text-[10px] text-muted-foreground uppercase">
                            (active)
                        </span>
                    )}
                </Row>
                <Row icon={Sparkles} label="Outlines">
                    <span className="font-medium">
                        {samRefined ? 'Refined with SAM' : 'Detector output'}
                    </span>
                </Row>
                <Row icon={Clock} label="Processing time">
                    <span className="font-medium tabular-nums">{formatElapsed(elapsedSecs)}</span>
                </Row>
            </dl>
        </section>
    );
}

interface LarvaeCalibrationDetailsProps {
    calibration: CalibrationCorners | null;
    onEditCorners: () => void;
    onEditManual: () => void;
    onRedetect: () => void;
    redetecting: boolean;
    disabled?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
    detected: 'Detected automatically',
    manual: 'Set by hand',
    failed: 'Not found',
};

/** Scale read-out with the three ways to change it. */
export function LarvaeCalibrationDetails({
    calibration,
    onEditCorners,
    onEditManual,
    onRedetect,
    redetecting,
    disabled = false,
}: LarvaeCalibrationDetailsProps) {
    const ok = calibrationUsable(calibration);
    const hasCorners = Boolean(calibration?.auto_corners) || Boolean(calibration?.edited_corners);
    const fmt = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(4));

    return (
        <section>
            <h3 className="eyebrow mb-2">Calibration</h3>
            <dl className="space-y-2 text-xs">
                <Row icon={Ruler} label="Scale">
                    <span className={cn('font-medium', calibration && !ok && 'text-warning')}>
                        {calibration
                            ? (STATUS_LABEL[calibration.detection_status] ??
                              calibration.detection_status)
                            : 'Not checked yet'}
                    </span>
                </Row>
                <div className="flex items-center justify-between gap-3">
                    <dt className="pl-5 text-muted-foreground">mm per pixel (x / y)</dt>
                    <dd className="font-mono tabular-nums">
                        {fmt(calibration?.mm_per_px_x)} / {fmt(calibration?.mm_per_px_y)}
                    </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <dt className="pl-5 text-muted-foreground">Reference rectangle</dt>
                    <dd className="font-mono tabular-nums">
                        {calibration?.calibration_object_w_mm ?? '—'} ×{' '}
                        {calibration?.calibration_object_h_mm ?? '—'} mm
                    </dd>
                </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-1.5">
                <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={onEditCorners}
                    disabled={disabled || !hasCorners}
                    title={
                        hasCorners
                            ? 'Drag the four corners onto the calibration rectangle'
                            : 'No corners to start from — use Manual scale'
                    }
                >
                    Drag corners
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={onEditManual}
                    disabled={disabled}
                >
                    Manual scale
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={onRedetect}
                    disabled={disabled || redetecting}
                >
                    {redetecting ? 'Detecting…' : calibration ? 'Re-detect' : 'Detect'}
                </Button>
            </div>
        </section>
    );
}
