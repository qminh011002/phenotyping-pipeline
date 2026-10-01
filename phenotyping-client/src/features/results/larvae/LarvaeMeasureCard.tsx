// LarvaeMeasureCard — the "measure" step, on demand.
//
// Batches are counted first; sizes are computed only when the user asks.
// The card shows whichever of these the image is in:
//   not measured → call to action (this image / whole batch, optional SAM)
//   running      → step + progress, cancellable for a batch run
//   out of date  → outlines changed since the last measure → recalculate
//   measured     → mean length / width / area

import { Loader2, RefreshCw, Ruler, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';

import type { LarvaeMeasurement, Organism } from '@/types/api';

import { MEASURE_STEP_LABEL, type MeasureStep } from './measureFlow';

export interface MeasureRun {
    scope: 'image' | 'batch';
    step: MeasureStep;
    /** Images finished / to do (1 / 1 for a single image). */
    done: number;
    total: number;
    filename: string;
    /** Image being processed right now. */
    imageId: string;
    cancelling: boolean;
}

interface LarvaeMeasureCardProps {
    organism: Organism;
    /** Detections on the current image. */
    count: number;
    measurements: LarvaeMeasurement[];
    /** Measurements exist but outlines changed since (or edits are unsaved). */
    outOfDate: boolean;
    /** A usable scale exists for the current image. */
    scaleOk: boolean;
    /** Calibration was never attempted — measuring will try to detect it. */
    scaleUntried: boolean;
    /** SAM has already refined this image. */
    samRefined: boolean;
    refine: boolean;
    onRefineChange: (next: boolean) => void;
    /** Images in the batch that still need measuring (current one included). */
    pendingInBatch: number;
    totalInBatch: number;
    run: MeasureRun | null;
    /** Measure the image on screen; `refine` overrides the checkbox. */
    onMeasureImage: (options?: { refine?: boolean }) => void;
    onMeasureBatch: () => void;
    onCancelRun: () => void;
    showCenterlines: boolean;
    onShowCenterlinesChange: (next: boolean) => void;
    disabled?: boolean;
}

function mean(values: Array<number | null | undefined>): number | null {
    const xs = values.filter((v): v is number => typeof v === 'number');
    if (xs.length === 0) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function Metric({ label, value, unit }: { label: string; value: number | null; unit: string }) {
    return (
        <div className="rounded-md bg-muted/50 px-2.5 py-2">
            <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                {label}
            </dt>
            <dd className="mt-0.5 flex items-baseline gap-1 tabular-nums">
                <span className="text-sm font-semibold text-foreground">
                    {value == null ? '—' : value.toFixed(2)}
                </span>
                <span className="text-[10px] text-muted-foreground">{unit}</span>
            </dd>
        </div>
    );
}

export function LarvaeMeasureCard({
    organism,
    count,
    measurements,
    outOfDate,
    scaleOk,
    scaleUntried,
    samRefined,
    refine,
    onRefineChange,
    pendingInBatch,
    totalInBatch,
    run,
    onMeasureImage,
    onMeasureBatch,
    onCancelRun,
    showCenterlines,
    onShowCenterlinesChange,
    disabled = false,
}: LarvaeMeasureCardProps) {
    const meta = organismMeta(organism);
    const measured = measurements.length > 0;
    const canMeasure = scaleOk || scaleUntried;
    const batchLabel =
        pendingInBatch === totalInBatch
            ? `Measure all ${totalInBatch} images`
            : `Measure the ${pendingInBatch} remaining image${pendingInBatch === 1 ? '' : 's'}`;
    // `pendingInBatch` includes the image on screen when it needs measuring;
    // the batch action is only worth showing if another image needs it too.
    const currentPending = count > 0 && (!measured || outOfDate);
    const showBatchAction = totalInBatch > 1 && pendingInBatch - (currentPending ? 1 : 0) > 0;

    // ── Running ─────────────────────────────────────────────────────────────
    if (run) {
        const pct = run.total > 0 ? (run.done / run.total) * 100 : 0;
        return (
            <section className="mx-4 mb-3 rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{MEASURE_STEP_LABEL[run.step]}…</span>
                    {run.scope === 'batch' && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                            onClick={onCancelRun}
                            disabled={run.cancelling}
                        >
                            <X className="size-3" />
                            {run.cancelling ? 'Stopping…' : 'Stop'}
                        </Button>
                    )}
                </div>
                {run.scope === 'batch' ? (
                    <>
                        <Progress value={pct} className="mt-2.5 h-1.5" />
                        <p className="mt-1.5 flex justify-between gap-2 text-[11px] text-muted-foreground">
                            <span className="truncate font-mono">{run.filename}</span>
                            <span className="shrink-0 tabular-nums">
                                {Math.min(run.done + 1, run.total)} of {run.total}
                            </span>
                        </p>
                    </>
                ) : (
                    <Progress indeterminate className="mt-2.5 h-1.5" />
                )}
            </section>
        );
    }

    // ── Measured ────────────────────────────────────────────────────────────
    if (measured) {
        return (
            <section className="mx-4 mb-3 space-y-2.5">
                {outOfDate && (
                    <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
                        <p className="min-w-0 flex-1 text-xs font-medium text-warning">
                            Outlines changed — sizes are out of date
                        </p>
                        <Button
                            size="sm"
                            className="h-7 shrink-0"
                            onClick={() => onMeasureImage()}
                            disabled={disabled || !canMeasure}
                            title={
                                canMeasure
                                    ? 'Recalculate length, width, area and weight'
                                    : 'Calibration is required before measurement'
                            }
                        >
                            <RefreshCw />
                            Recalculate
                        </Button>
                    </div>
                )}
                <dl className={cn('grid grid-cols-3 gap-2', outOfDate && 'opacity-60')}>
                    <Metric
                        label="Mean length"
                        value={mean(measurements.map((m) => m.length_mm))}
                        unit="mm"
                    />
                    <Metric
                        label="Mean width"
                        value={mean(measurements.map((m) => m.max_width_mm))}
                        unit="mm"
                    />
                    <Metric
                        label="Mean area"
                        value={mean(measurements.map((m) => m.area_mm2))}
                        unit="mm²"
                    />
                </dl>
                <div className="flex items-center justify-between gap-2 text-xs">
                    <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                        <Switch
                            checked={showCenterlines}
                            onCheckedChange={onShowCenterlinesChange}
                            aria-label="Show centerlines"
                        />
                        Centerlines
                    </label>
                    <div className="flex items-center gap-1">
                        {!samRefined && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground"
                                onClick={() => onMeasureImage({ refine: true })}
                                disabled={disabled || !canMeasure}
                                title="Tighten the outlines with SAM, then measure again — slower, especially without a GPU"
                            >
                                <Sparkles />
                                Refine
                            </Button>
                        )}
                        {!outOfDate && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground"
                                onClick={() => onMeasureImage()}
                                disabled={disabled || !canMeasure}
                                title="Measure this image again"
                            >
                                <RefreshCw />
                                Re-measure
                            </Button>
                        )}
                    </div>
                </div>
                {showBatchAction && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={onMeasureBatch}
                        disabled={disabled}
                    >
                        <Ruler />
                        {batchLabel}
                    </Button>
                )}
            </section>
        );
    }

    // ── Not measured yet ────────────────────────────────────────────────────
    return (
        <section className="mx-4 mb-3 rounded-lg border border-border bg-background p-3">
            <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Ruler className="size-4" aria-hidden />
                </span>
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold">Measure size and weight</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {count === 0
                            ? `No ${meta.nounPlural} on this image to measure.`
                            : `This image was only counted. Measure to get length, width and area for each ${meta.noun}.`}
                    </p>
                </div>
            </div>
            {!samRefined && count > 0 && (
                <RefineOption
                    refine={refine}
                    onRefineChange={onRefineChange}
                    disabled={disabled}
                    className="mt-3"
                />
            )}
            <div className="mt-3 flex flex-col gap-2">
                <Button
                    size="sm"
                    onClick={() => onMeasureImage()}
                    disabled={disabled || count === 0 || !canMeasure}
                    title={canMeasure ? undefined : 'Set the calibration first'}
                >
                    <Ruler />
                    Measure this image
                </Button>
                {showBatchAction && (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={onMeasureBatch}
                        disabled={disabled}
                    >
                        {batchLabel}
                    </Button>
                )}
            </div>
            {!canMeasure && count > 0 && (
                <p className="mt-2 text-[11px] text-warning">
                    A scale is needed first — set the calibration below.
                </p>
            )}
        </section>
    );
}

function RefineOption({
    refine,
    onRefineChange,
    disabled,
    className,
}: {
    refine: boolean;
    onRefineChange: (next: boolean) => void;
    disabled: boolean;
    className?: string;
}) {
    return (
        <label
            className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md bg-muted/50 px-2.5 py-2',
                className,
            )}
        >
            <Checkbox
                checked={refine}
                onCheckedChange={(v) => onRefineChange(Boolean(v))}
                disabled={disabled}
                className="mt-0.5"
            />
            <span className="min-w-0 text-xs">
                <span className="flex items-center gap-1 font-medium text-foreground">
                    <Sparkles className="size-3 text-muted-foreground" aria-hidden />
                    Refine outlines with SAM first
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                    Tighter outlines, more accurate sizes — slower, especially without a GPU.
                </span>
            </span>
        </label>
    );
}
