// StatBoard — inspector for the bbox (egg / neonate) result viewer.
// One scrollable column of section blocks, so the hierarchy reads
// "count → filter → distribution → inference → params" at a glance. The
// parameters section collapses to keep the default view on the numbers the
// operator actually acts on.

import { useMemo, useState } from 'react';
import { ChevronDown, Clock, Microscope, Settings2, SlidersHorizontal } from 'lucide-react';

import { AnimatedNumber } from '@/components/common/AnimatedNumber';
import { OrganismBadge } from '@/components/common';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { organismMeta } from '@/lib/organism';
import type { BBox, DetectionResult, Organism } from '@/types/api';
import { cn } from '@/lib/utils';

interface StatBoardProps {
    result: DetectionResult;
    /** Organism of the batch — drives the wording ("Eggs counted"). */
    organism?: Organism;
    /** The config snapshot recorded when processing started */
    config?: Record<string, unknown> | null;
    /** Annotations currently visible (filtered by confidenceThreshold) */
    visibleAnnotations: BBox[];
    confidenceThreshold: number;
    onConfidenceChange: (value: number) => void;
    /** FS-009: editor is active */
    editMode?: boolean;
    /** Original model boxes — baseline for the "Edits" summary. */
    modelBoxes?: BBox[];
    /** Current session boxes — compared against `modelBoxes`. */
    sessionBoxes?: BBox[];
}

const PRESETS: number[] = [0, 0.5, 0.7, 0.9];

const EMPTY_BOXES: BBox[] = [];

const CONFIG_KEYS: Array<[string, string]> = [
    ['confidence_threshold', 'Confidence threshold'],
    ['tile_size', 'Tile size'],
    ['overlap', 'Overlap'],
    ['dedup_mode', 'Dedup mode'],
    ['min_box_area', 'Min box area'],
    ['edge_margin', 'Edge margin'],
    ['nms_iou_threshold', 'NMS IoU'],
    ['batch_size', 'Batch size'],
];

// Confidence bands are an ordinal, status-like scale: good → weak.
const BUCKETS = [
    { label: '≥ 90%', color: 'bg-success' },
    { label: '70–89%', color: 'bg-success/60' },
    { label: '50–69%', color: 'bg-warning' },
    { label: '< 50%', color: 'bg-destructive' },
] as const;

const boxKey = (b: BBox) => b.bbox.join(',');

function SectionHeader({
    label,
    icon: Icon,
    aside,
}: {
    label: string;
    icon?: React.ElementType;
    aside?: React.ReactNode;
}) {
    return (
        <div className="mb-3 flex min-h-5 items-center gap-2">
            <h3 className="eyebrow flex items-center gap-1.5">
                {Icon && <Icon className="size-3.5" aria-hidden />}
                {label}
            </h3>
            {aside !== undefined && <div className="ml-auto flex items-center">{aside}</div>}
        </div>
    );
}

function ConfBadge({ value }: { value: number }) {
    const ok = value >= 0.7;
    const mid = !ok && value >= 0.5;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 font-mono text-xs font-semibold tabular-nums',
                'text-foreground',
            )}
        >
            {/* The dot carries the status colour; the number stays in ink. */}
            <span
                aria-hidden
                className={cn(
                    'size-1.5 rounded-full',
                    ok && 'bg-success',
                    mid && 'bg-warning',
                    !ok && !mid && 'bg-destructive',
                )}
            />
            {value > 0 ? `${(value * 100).toFixed(1)}%` : '—'}
        </span>
    );
}

export function StatBoard({
    result,
    organism,
    config,
    visibleAnnotations,
    confidenceThreshold,
    onConfidenceChange,
    editMode = false,
    modelBoxes = EMPTY_BOXES,
    sessionBoxes = EMPTY_BOXES,
}: StatBoardProps) {
    const meta = organismMeta(organism ?? result.organism);
    const nounPlural = meta.nounPlural;
    const heroLabel = `${nounPlural.charAt(0).toUpperCase()}${nounPlural.slice(1)} counted`;

    // What the reviewer changed relative to the model output. A moved or
    // resized box counts once on each side (it left the model set and a new
    // one appeared).
    const model = useMemo(() => {
        const refs = new Set<BBox>(modelBoxes);
        const keys = new Set<string>();
        for (const b of modelBoxes) keys.add(boxKey(b));
        return { refs, keys };
    }, [modelBoxes]);
    const edits = useMemo(() => {
        if (!editMode) return null;
        let kept = 0;
        // Untouched boxes are usually the very same objects; only the rest
        // need the geometry comparison.
        for (const b of sessionBoxes) {
            if (model.refs.has(b) || model.keys.has(boxKey(b))) kept += 1;
        }
        const added = sessionBoxes.length - kept;
        const removed = modelBoxes.length - kept;
        return added > 0 || removed > 0 ? { added, removed } : null;
    }, [editMode, model, modelBoxes.length, sessionBoxes]);

    const totalCount = result.annotations.length;
    const visibleCount = visibleAnnotations.length;
    const visibleRatio = totalCount > 0 ? visibleCount / totalCount : 0;

    const avgConfVisible = useMemo(
        () =>
            visibleCount > 0
                ? visibleAnnotations.reduce((s, a) => s + a.confidence, 0) / visibleCount
                : 0,
        [visibleAnnotations, visibleCount],
    );

    // Single-pass confidence breakdown over all annotations (not the
    // filtered subset) — the distribution is a property of the model output,
    // not of the current view.
    const breakdown = useMemo(() => {
        const counts = [0, 0, 0, 0];
        for (const a of result.annotations) {
            const c = a.confidence;
            if (c >= 0.9) counts[0] += 1;
            else if (c >= 0.7) counts[1] += 1;
            else if (c >= 0.5) counts[2] += 1;
            else counts[3] += 1;
        }
        return counts;
    }, [result.annotations]);

    const [paramsOpen, setParamsOpen] = useState(false);
    const hasConfig = Boolean(config && Object.keys(config).length > 0);

    return (
        <div className="flex h-full flex-col divide-y divide-border overflow-y-auto">
            {/* ── Detections (hero) ───────────────────────────────────────── */}
            <section className="px-5 py-5">
                <SectionHeader
                    label={heroLabel}
                    icon={Microscope}
                    aside={
                        confidenceThreshold > 0 ? (
                            <span className="rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning">
                                Filtered
                            </span>
                        ) : null
                    }
                />
                <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-semibold leading-none tracking-tight tabular-nums">
                        <AnimatedNumber value={visibleCount} className="tabular-nums" />
                    </span>
                    {visibleCount !== totalCount && (
                        <span className="font-mono text-sm text-muted-foreground tabular-nums">
                            / {totalCount}
                        </span>
                    )}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                        {confidenceThreshold > 0
                            ? `at ≥ ${(confidenceThreshold * 100).toFixed(0)}% confidence`
                            : totalCount === 0
                              ? `no ${nounPlural} detected`
                              : `showing all ${nounPlural}`}
                    </span>
                    {totalCount > 0 && (
                        <span className="font-mono font-medium tabular-nums">
                            {(visibleRatio * 100).toFixed(0)}%
                        </span>
                    )}
                </div>
                {totalCount > 0 && (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                        <div
                            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                            style={{ width: `${visibleRatio * 100}%` }}
                        />
                    </div>
                )}
                {edits && (
                    <div className="mt-4 flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">Your edits vs model</span>
                        <span className="flex items-center gap-1.5 font-mono font-medium tabular-nums">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5">
                                        +{edits.added}
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                    Boxes you drew, moved or resized
                                </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5">
                                        −{edits.removed}
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                    Model boxes you deleted, moved or resized
                                </TooltipContent>
                            </Tooltip>
                        </span>
                    </div>
                )}
            </section>

            {/* ── Confidence filter (slider + avg + presets) ──────────────── */}
            <section className="px-5 py-5">
                <SectionHeader
                    label="Confidence Filter"
                    icon={SlidersHorizontal}
                    aside={
                        visibleCount > 0 ? (
                            <span className="inline-flex items-center gap-1.5">
                                <span className="eyebrow text-[10px]">Avg</span>
                                <ConfBadge value={avgConfVisible} />
                            </span>
                        ) : null
                    }
                />
                <div className="flex items-center gap-3">
                    <Slider
                        value={[confidenceThreshold]}
                        onValueChange={(v) => onConfidenceChange(v[0] ?? 0)}
                        min={0}
                        max={1}
                        step={0.01}
                        className="flex-1"
                    />
                    <span className="w-10 text-right font-mono text-sm font-semibold tabular-nums">
                        {(confidenceThreshold * 100).toFixed(0)}%
                    </span>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-1.5">
                    {PRESETS.map((v) => {
                        const active = Math.abs(confidenceThreshold - v) < 1e-6;
                        return (
                            <button
                                key={v}
                                type="button"
                                onClick={() => onConfidenceChange(v)}
                                className={cn(
                                    'h-7 rounded-md font-mono text-xs font-medium transition-colors',
                                    'focus:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/60',
                                    active
                                        ? 'bg-primary text-primary-foreground shadow-sm'
                                        : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                                )}
                            >
                                {v === 0 ? 'All' : `≥${Math.round(v * 100)}%`}
                            </button>
                        );
                    })}
                </div>
            </section>

            {/* ── Distribution (stacked bar + legend) ─────────────────────── */}
            {totalCount > 0 && (
                <section className="px-5 py-5">
                    <SectionHeader
                        label="Distribution"
                        aside={
                            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                                {totalCount} total
                            </span>
                        }
                    />
                    {/* 2px surface gap between segments keeps adjacent bands apart. */}
                    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
                        {BUCKETS.map((b, i) => {
                            const pct = (breakdown[i] / totalCount) * 100;
                            if (pct <= 0) return null;
                            return (
                                <div
                                    key={b.label}
                                    className={cn('h-full', b.color)}
                                    style={{ width: `${pct}%` }}
                                    title={`${b.label}: ${breakdown[i]}`}
                                />
                            );
                        })}
                    </div>
                    <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
                        {BUCKETS.map((b, i) => (
                            <li key={b.label} className="flex items-center gap-2 text-xs">
                                <span
                                    aria-hidden
                                    className={cn('size-2 shrink-0 rounded-sm', b.color)}
                                />
                                <span className="text-muted-foreground">{b.label}</span>
                                <span className="ml-auto font-mono font-medium tabular-nums">
                                    {breakdown[i]}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* ── Inference (organism, time) ──────────────────────────────── */}
            <section className="px-5 py-5">
                <SectionHeader label="Inference" icon={Clock} />
                <dl className="space-y-2.5 text-sm">
                    <div className="flex items-center justify-between">
                        <dt className="text-muted-foreground">Organism</dt>
                        <dd>
                            <OrganismBadge organism={meta.id} />
                        </dd>
                    </div>
                    <div className="flex items-center justify-between">
                        <dt className="text-muted-foreground">Processing time</dt>
                        <dd className="font-mono tabular-nums">
                            {result.elapsed_seconds >= 0
                                ? `${result.elapsed_seconds.toFixed(2)}s`
                                : '—'}
                        </dd>
                    </div>
                </dl>
            </section>

            {/* ── Inference parameters (collapsible) ──────────────────────── */}
            {hasConfig && (
                <section className="px-5 py-4">
                    <button
                        type="button"
                        onClick={() => setParamsOpen((o) => !o)}
                        aria-expanded={paramsOpen}
                        className={cn(
                            'flex w-full items-center justify-between rounded-sm text-left',
                            'focus:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/60',
                        )}
                    >
                        <span className="eyebrow flex items-center gap-1.5">
                            <Settings2 className="size-3.5" aria-hidden />
                            Inference Parameters
                        </span>
                        <ChevronDown
                            className={cn(
                                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                                paramsOpen && 'rotate-180',
                            )}
                        />
                    </button>
                    {paramsOpen && (
                        <div className="mt-3 space-y-1.5">
                            {CONFIG_KEYS.map(([key, label]) => {
                                const val = config?.[key];
                                if (val === undefined || val === null) return null;
                                const isPercent =
                                    (typeof val === 'number' && key.includes('threshold')) ||
                                    key === 'overlap' ||
                                    key === 'nms_iou_threshold';
                                return (
                                    <div
                                        key={key}
                                        className="flex items-center justify-between text-xs"
                                    >
                                        <span className="text-muted-foreground">{label}</span>
                                        <span className="font-mono font-medium tabular-nums">
                                            {isPercent
                                                ? `${(Number(val) * 100).toFixed(1)}%`
                                                : String(val)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
