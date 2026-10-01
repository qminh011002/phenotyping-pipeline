// Mean count per image for the most recent batches, one small panel per
// organism (each with its own scale — an egg plate and a larvae tray are not
// comparable on one axis). A thin whisker shows the min–max spread across
// the batch's images.

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatNumber, formatShortDate } from '@/lib/format';
import { ORGANISM_ORDER, organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';
import type { DashboardBatchRow, DashboardOverview, Organism } from '@/types/api';

import { ChartCard, ChartEmpty, DataTable } from './ChartCard';

function OrganismPanel({ organism, rows }: { organism: Organism; rows: DashboardBatchRow[] }) {
    const navigate = useNavigate();
    const meta = organismMeta(organism);
    const scaleMax = Math.max(1, ...rows.map((r) => r.max_count ?? r.mean_count ?? 0));

    return (
        <div className="min-w-0">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: meta.color }}
                />
                {meta.label}
                <span className="font-normal text-muted-foreground">
                    · {meta.nounPlural} per image
                </span>
            </h3>
            <ul className="space-y-0.5">
                {rows.map((row) => {
                    const mean = row.mean_count ?? 0;
                    const hasRange =
                        row.min_count != null &&
                        row.max_count != null &&
                        row.max_count > row.min_count;
                    const detail = `${row.name} — mean ${formatNumber(mean)} per image${
                        hasRange ? `, range ${row.min_count}–${row.max_count}` : ''
                    } across ${row.images} image${row.images === 1 ? '' : 's'}`;
                    return (
                        <li key={row.id}>
                            <button
                                type="button"
                                onClick={() => navigate(`/recorded?batch=${row.id}`)}
                                title={detail}
                                aria-label={detail}
                                className={cn(
                                    'group grid w-full grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-3 rounded-md px-1.5 py-1 text-left',
                                    'transition-colors duration-150 hover:bg-muted/70',
                                    'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                )}
                            >
                                <span className="min-w-0">
                                    <span className="block truncate text-xs font-medium text-foreground">
                                        {row.name}
                                    </span>
                                    <span className="block truncate text-[11px] text-muted-foreground">
                                        {formatShortDate(row.created_at)} · {row.images} img
                                    </span>
                                </span>
                                <span className="relative h-3" aria-hidden>
                                    <span className="absolute inset-y-0 left-0 w-px bg-chart-axis" />
                                    <span
                                        className="absolute inset-y-0 left-px rounded-r-[4px] transition-[filter] duration-150 group-hover:brightness-110"
                                        style={{
                                            width: `${(mean / scaleMax) * 100}%`,
                                            minWidth: 2,
                                            backgroundColor: meta.color,
                                        }}
                                    />
                                    {hasRange && (
                                        <span
                                            className="absolute top-1/2 h-px -translate-y-1/2 bg-foreground/70"
                                            style={{
                                                left: `${(row.min_count! / scaleMax) * 100}%`,
                                                width: `${((row.max_count! - row.min_count!) / scaleMax) * 100}%`,
                                            }}
                                        >
                                            <span className="absolute top-1/2 left-0 h-2 w-px -translate-y-1/2 bg-foreground/70" />
                                            <span className="absolute top-1/2 right-0 h-2 w-px -translate-y-1/2 bg-foreground/70" />
                                        </span>
                                    )}
                                </span>
                                <span className="text-right text-xs font-medium text-foreground tabular-nums">
                                    {formatNumber(mean)}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export function BatchComparisonCard({ overview }: { overview: DashboardOverview }) {
    const groups = useMemo(() => {
        const byOrganism = new Map<Organism, DashboardBatchRow[]>();
        for (const row of overview.batches) {
            if (!byOrganism.has(row.organism)) byOrganism.set(row.organism, []);
            byOrganism.get(row.organism)!.push(row);
        }
        return ORGANISM_ORDER.filter((o) => byOrganism.has(o)).map(
            (o) => [o, byOrganism.get(o)!] as const,
        );
    }, [overview.batches]);

    return (
        <ChartCard
            title="Count per image by batch"
            subtitle="Mean of each recent batch, oldest first · whisker = lowest to highest image"
            table={
                overview.batches.length > 0 ? (
                    <DataTable
                        columns={[
                            { label: 'Batch' },
                            { label: 'Organism' },
                            { label: 'Images', numeric: true },
                            { label: 'Mean / image', numeric: true },
                            { label: 'Min', numeric: true },
                            { label: 'Max', numeric: true },
                        ]}
                        rows={overview.batches.map((b) => [
                            b.name,
                            organismMeta(b.organism).label,
                            b.images,
                            formatNumber(b.mean_count),
                            b.min_count ?? '—',
                            b.max_count ?? '—',
                        ])}
                    />
                ) : undefined
            }
        >
            {groups.length === 0 ? (
                <ChartEmpty>No batches in this period yet.</ChartEmpty>
            ) : (
                <div className={cn('grid gap-x-8 gap-y-6', groups.length > 1 && 'lg:grid-cols-2')}>
                    {groups.map(([organism, rows]) => (
                        <OrganismPanel key={organism} organism={organism} rows={rows} />
                    ))}
                </div>
            )}
        </ChartCard>
    );
}
