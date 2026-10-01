// ColumnChart — stacked (or single-series) columns drawn with plain HTML.
//
// One baseline, thin columns (≤ 24px) with a rounded data-end, a 2px surface
// gap between stacked segments, solid hairline gridlines. Hovering or
// focusing a column band shows one tooltip listing every series at that
// position, so the pointer never has to land on a segment.

import { useId, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { labelIndices, niceTicks } from '../lib/scale';

export interface ColumnSeries {
    key: string;
    label: string;
    color: string;
}

export interface ColumnDatum {
    key: string;
    /** Axis label (may be hidden when columns are dense). */
    label: string;
    /** Tooltip heading; defaults to `label`. */
    title?: string;
    /** One value per series, same order as `series`. */
    values: number[];
}

/** A vertical reference line at a fractional x position (0 = left edge). */
export interface ColumnMarker {
    position: number;
    label: string;
}

interface ColumnChartProps {
    series: ColumnSeries[];
    data: ColumnDatum[];
    /** Plot height in px (axis labels are added below it). */
    height?: number;
    formatValue?: (value: number) => string;
    /** Shown after the total in the tooltip when there are several series. */
    totalLabel?: string;
    markers?: ColumnMarker[];
    /** Label under the x axis (e.g. the unit). */
    xCaption?: ReactNode;
    ariaLabel: string;
}

export function ColumnChart({
    series,
    data,
    height = 200,
    formatValue = (v) => v.toLocaleString(),
    totalLabel,
    markers,
    xCaption,
    ariaLabel,
}: ColumnChartProps) {
    const [active, setActive] = useState<number | null>(null);
    const tooltipId = useId();
    const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
    const ticks = niceTicks(Math.max(0, ...totals));
    const top = ticks[ticks.length - 1];
    const labelled = labelIndices(data.length);
    const activeDatum = active !== null ? data[active] : null;

    return (
        <div role="group" aria-label={ariaLabel}>
            {series.length > 1 && (
                <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {series.map((s) => (
                        <li key={s.key} className="flex items-center gap-1.5">
                            <span
                                aria-hidden
                                className="size-2.5 rounded-[3px]"
                                style={{ backgroundColor: s.color }}
                            />
                            {s.label}
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex gap-2">
                {/* Y axis */}
                <div
                    className="relative w-9 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums"
                    style={{ height }}
                    aria-hidden
                >
                    {ticks.map((t) => (
                        <span
                            key={t}
                            className="absolute right-0 -translate-y-1/2 leading-none"
                            style={{ top: `${(1 - t / top) * 100}%` }}
                        >
                            {formatValue(t)}
                        </span>
                    ))}
                </div>

                <div className="relative min-w-0 flex-1">
                    <div className="relative" style={{ height }}>
                        {ticks.map((t) => (
                            <div
                                key={t}
                                aria-hidden
                                className={cn(
                                    'absolute inset-x-0 h-px',
                                    t === 0 ? 'bg-chart-axis' : 'bg-chart-grid',
                                )}
                                style={{ top: `${(1 - t / top) * 100}%` }}
                            />
                        ))}

                        {markers?.map((m) => (
                            <div
                                key={m.label}
                                aria-hidden
                                className="absolute inset-y-0 z-10 w-px bg-foreground/55"
                                style={{ left: `${Math.min(1, Math.max(0, m.position)) * 100}%` }}
                            >
                                <span
                                    className={cn(
                                        'absolute top-0 rounded-sm bg-card px-1 text-[10px] font-medium whitespace-nowrap text-foreground',
                                        m.position > 0.7 ? 'right-1' : 'left-1',
                                    )}
                                >
                                    {m.label}
                                </span>
                            </div>
                        ))}

                        <div className="absolute inset-0 flex items-end">
                            {data.map((d, i) => {
                                const lastFilled = d.values.reduce(
                                    (last, v, idx) => (v > 0 ? idx : last),
                                    -1,
                                );
                                return (
                                    <div
                                        key={d.key}
                                        tabIndex={0}
                                        aria-describedby={active === i ? tooltipId : undefined}
                                        aria-label={`${d.title ?? d.label}: ${series
                                            .map(
                                                (s, idx) =>
                                                    `${s.label} ${formatValue(d.values[idx])}`,
                                            )
                                            .join(', ')}`}
                                        onPointerEnter={() => setActive(i)}
                                        onPointerLeave={() =>
                                            setActive((a) => (a === i ? null : a))
                                        }
                                        onFocus={() => setActive(i)}
                                        onBlur={() => setActive((a) => (a === i ? null : a))}
                                        className={cn(
                                            'group relative flex h-full min-w-0 flex-1 flex-col-reverse items-center rounded-sm px-px outline-none',
                                            'focus-visible:ring-[2px] focus-visible:ring-ring/60',
                                            active === i && 'bg-foreground/[0.04]',
                                        )}
                                    >
                                        {d.values.map((v, idx) =>
                                            v > 0 ? (
                                                <div
                                                    key={series[idx].key}
                                                    className={cn(
                                                        'w-full max-w-6 shrink-0 transition-[filter] duration-150',
                                                        idx === lastFilled && 'rounded-t-[4px]',
                                                        active === i && 'brightness-110',
                                                    )}
                                                    style={{
                                                        height: `${(v / top) * 100}%`,
                                                        minHeight: 2,
                                                        backgroundColor: series[idx].color,
                                                        // 2px surface gap between stacked segments.
                                                        borderTop:
                                                            idx !== lastFilled
                                                                ? '2px solid var(--card)'
                                                                : undefined,
                                                    }}
                                                />
                                            ) : null,
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {activeDatum && active !== null && (
                            <div
                                id={tooltipId}
                                role="tooltip"
                                className={cn(
                                    'floating-panel pointer-events-none absolute bottom-full z-20 mb-1.5 min-w-32 px-3 py-2 text-xs',
                                    active < data.length * 0.2
                                        ? 'left-0'
                                        : active > data.length * 0.8
                                          ? 'right-0'
                                          : '-translate-x-1/2',
                                )}
                                style={
                                    active >= data.length * 0.2 && active <= data.length * 0.8
                                        ? { left: `${((active + 0.5) / data.length) * 100}%` }
                                        : undefined
                                }
                            >
                                <p className="mb-1 font-medium whitespace-nowrap text-muted-foreground">
                                    {activeDatum.title ?? activeDatum.label}
                                </p>
                                <ul className="space-y-0.5">
                                    {series.map((s, idx) => (
                                        <li
                                            key={s.key}
                                            className="flex items-center gap-2 whitespace-nowrap"
                                        >
                                            <span
                                                aria-hidden
                                                className="h-0.5 w-3 rounded-full"
                                                style={{ backgroundColor: s.color }}
                                            />
                                            <span className="font-semibold text-foreground tabular-nums">
                                                {formatValue(activeDatum.values[idx])}
                                            </span>
                                            <span className="text-muted-foreground">{s.label}</span>
                                        </li>
                                    ))}
                                </ul>
                                {series.length > 1 && (
                                    <p className="mt-1 border-t border-border pt-1 whitespace-nowrap text-muted-foreground">
                                        <span className="font-semibold text-foreground tabular-nums">
                                            {formatValue(totals[active])}
                                        </span>{' '}
                                        {totalLabel ?? 'total'}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    {/* X axis */}
                    <div className="mt-1.5 flex text-[11px] text-muted-foreground" aria-hidden>
                        {data.map((d, i) => (
                            <span key={d.key} className="relative h-4 min-w-0 flex-1">
                                {labelled.has(i) && (
                                    <span
                                        className={cn(
                                            'absolute top-0 whitespace-nowrap',
                                            i === 0
                                                ? 'left-0'
                                                : i === data.length - 1
                                                  ? 'right-0'
                                                  : 'left-1/2 -translate-x-1/2',
                                        )}
                                    >
                                        {d.label}
                                    </span>
                                )}
                            </span>
                        ))}
                    </div>
                    {xCaption && (
                        <p className="mt-1 text-center text-[11px] text-muted-foreground">
                            {xCaption}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
