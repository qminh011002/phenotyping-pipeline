// Distribution of a measured trait (length, width, area, weight) across all
// measured larvae / pupae in the window — one histogram per organism.

import { useMemo, useState } from 'react';
import { Ruler } from 'lucide-react';

import { SegmentedControl } from '@/components/common';
import { formatNumber } from '@/lib/format';
import { ORGANISM_ORDER, organismMeta } from '@/lib/organism';
import type { DashboardSizeStats, SizeMetric } from '@/types/api';

import { ChartCard, ChartEmpty, DataTable } from './ChartCard';
import { ColumnChart } from './ColumnChart';

const METRICS: Array<{ value: SizeMetric; label: string; noun: string }> = [
    { value: 'length_mm', label: 'Length', noun: 'body length' },
    { value: 'max_width_mm', label: 'Width', noun: 'maximum width' },
    { value: 'area_mm2', label: 'Area', noun: 'projected area' },
    { value: 'weight_mg', label: 'Weight', noun: 'weight' },
];

function digitsFor(stats: DashboardSizeStats): number {
    const span = (stats.p95 ?? 0) - (stats.p5 ?? 0);
    return span >= 50 ? 0 : span >= 5 ? 1 : 2;
}

function Histogram({ stats }: { stats: DashboardSizeStats }) {
    const meta = organismMeta(stats.organism);
    const digits = digitsFor(stats);
    const lo = stats.bins[0]?.start ?? 0;
    const hi = stats.bins[stats.bins.length - 1]?.end ?? 1;
    const fmt = (v: number | null) => formatNumber(v, digits);

    return (
        <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <span
                        aria-hidden
                        className="size-2 rounded-full"
                        style={{ backgroundColor: meta.color }}
                    />
                    {meta.label}
                    <span className="font-normal text-muted-foreground">
                        · {stats.n.toLocaleString()} measured
                    </span>
                </h3>
                <dl className="flex gap-4 text-[11px] text-muted-foreground">
                    <div className="flex gap-1">
                        <dt>Median</dt>
                        <dd className="font-medium text-foreground tabular-nums">
                            {fmt(stats.median)} {stats.unit}
                        </dd>
                    </div>
                    <div className="flex gap-1">
                        <dt>P5–P95</dt>
                        <dd className="font-medium text-foreground tabular-nums">
                            {fmt(stats.p5)}–{fmt(stats.p95)}
                        </dd>
                    </div>
                </dl>
            </div>
            {stats.bins.length === 0 ? (
                <ChartEmpty className="h-40">
                    Every measured value is {fmt(stats.median)} {stats.unit}.
                </ChartEmpty>
            ) : (
                <ColumnChart
                    series={[{ key: stats.organism, label: meta.nounPlural, color: meta.color }]}
                    data={stats.bins.map((b) => ({
                        key: String(b.start),
                        label: fmt(b.start),
                        title: `${fmt(b.start)}–${fmt(b.end)} ${stats.unit}`,
                        values: [b.count],
                    }))}
                    markers={
                        stats.median != null && hi > lo
                            ? [{ position: (stats.median - lo) / (hi - lo), label: 'Median' }]
                            : undefined
                    }
                    height={150}
                    xCaption={stats.unit}
                    ariaLabel={`${meta.label} ${stats.metric} distribution`}
                />
            )}
        </div>
    );
}

interface SizeDistributionCardProps {
    sizes: DashboardSizeStats[];
    /** What the distributions cover — worded into the subtitle and empty states. */
    scope?: 'period' | 'batch';
}

export function SizeDistributionCard({ sizes, scope = 'period' }: SizeDistributionCardProps) {
    const [metric, setMetric] = useState<SizeMetric>('length_mm');

    const available = useMemo(() => new Set(sizes.map((s) => s.metric)), [sizes]);
    // Fall back when the chosen trait has no data in this slice (e.g. weight
    // is only present where the operator entered tray weights).
    const effective = available.has(metric)
        ? metric
        : (METRICS.find((m) => available.has(m.value))?.value ?? metric);
    const panels = ORGANISM_ORDER.map((o) =>
        sizes.find((s) => s.organism === o && s.metric === effective),
    ).filter((s): s is DashboardSizeStats => s !== undefined);
    const noun = METRICS.find((m) => m.value === effective)?.noun ?? 'size';

    return (
        <ChartCard
            title="Size distribution"
            subtitle={
                scope === 'batch'
                    ? `Measured ${noun} of every individual in this batch · bars span the 1st–99th percentile`
                    : `Measured ${noun} of individual larvae and pupae · bars span the 1st–99th percentile`
            }
            controls={
                sizes.length > 0 ? (
                    <SegmentedControl
                        aria-label="Measured trait"
                        size="sm"
                        value={effective}
                        onChange={setMetric}
                        options={METRICS.map((m) => ({
                            value: m.value,
                            label: m.label,
                            disabled: !available.has(m.value),
                            title: available.has(m.value)
                                ? undefined
                                : `No ${m.noun} measurements in this ${scope}`,
                        }))}
                    />
                ) : undefined
            }
            table={
                panels.length > 0 ? (
                    <DataTable
                        columns={[
                            { label: 'Organism' },
                            { label: 'n', numeric: true },
                            { label: 'Mean', numeric: true },
                            { label: 'Median', numeric: true },
                            { label: 'P5', numeric: true },
                            { label: 'P95', numeric: true },
                            { label: 'Min', numeric: true },
                            { label: 'Max', numeric: true },
                        ]}
                        rows={panels.map((s) => [
                            `${organismMeta(s.organism).label} (${s.unit})`,
                            s.n.toLocaleString(),
                            formatNumber(s.mean, 2),
                            formatNumber(s.median, 2),
                            formatNumber(s.p5, 2),
                            formatNumber(s.p95, 2),
                            formatNumber(s.min, 2),
                            formatNumber(s.max, 2),
                        ])}
                    />
                ) : undefined
            }
            className="h-full"
        >
            {panels.length === 0 ? (
                <ChartEmpty className="h-56 flex-col gap-2">
                    <Ruler className="size-5 text-muted-foreground/60" aria-hidden />
                    <span>
                        {scope === 'batch'
                            ? 'Nothing in this batch has been measured yet. Open it in the review tool and choose '
                            : 'No size measurements in this period. Open a larvae or pupae batch and choose '}
                        <span className="font-medium text-foreground">Measure</span> to add them.
                    </span>
                </ChartEmpty>
            ) : (
                <div
                    className={
                        panels.length > 1 ? 'grid gap-x-8 gap-y-6 lg:grid-cols-2' : undefined
                    }
                >
                    {panels.map((s) => (
                        <Histogram key={`${s.organism}:${s.metric}`} stats={s} />
                    ))}
                </div>
            )}
        </ChartCard>
    );
}
