// Images analysed per day / week / month, stacked by organism.

import { useMemo } from 'react';

import { formatMonth, formatShortDate } from '@/lib/format';
import { ORGANISM_ORDER, organismMeta } from '@/lib/organism';
import type { DashboardBucket, DashboardOverview } from '@/types/api';

import { ChartCard, ChartEmpty, DataTable } from './ChartCard';
import { ColumnChart, type ColumnDatum, type ColumnSeries } from './ColumnChart';

const fullDate = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
});
const fullMonth = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

function bucketTitle(iso: string, bucket: DashboardBucket): string {
    const d = new Date(iso);
    if (bucket === 'month') return fullMonth.format(d);
    if (bucket === 'week') return `Week of ${fullDate.format(d)}`;
    return fullDate.format(d);
}

const BUCKET_NOUN: Record<DashboardBucket, string> = { day: 'day', week: 'week', month: 'month' };

export function ThroughputCard({ overview }: { overview: DashboardOverview }) {
    const { series, data, total } = useMemo(() => {
        // Colour follows the organism, so the series list is the fixed
        // organism order filtered to those present — never re-ranked.
        const present = new Set(overview.timeseries.map((p) => p.organism));
        const organisms = ORGANISM_ORDER.filter((o) => present.has(o));
        const series: ColumnSeries[] = organisms.map((o) => {
            const meta = organismMeta(o);
            return { key: o, label: meta.label, color: meta.color };
        });
        const byBucket = new Map<number, Map<string, number>>();
        for (const p of overview.timeseries) {
            const key = new Date(p.bucket).getTime();
            if (!byBucket.has(key)) byBucket.set(key, new Map());
            byBucket.get(key)!.set(p.organism, p.images);
        }
        let total = 0;
        const data: ColumnDatum[] = overview.buckets.map((iso) => {
            const values = organisms.map((o) => byBucket.get(new Date(iso).getTime())?.get(o) ?? 0);
            total += values.reduce((a, b) => a + b, 0);
            return {
                key: iso,
                label: overview.bucket === 'month' ? formatMonth(iso) : formatShortDate(iso),
                title: bucketTitle(iso, overview.bucket),
                values,
            };
        });
        return { series, data, total };
    }, [overview]);

    return (
        <ChartCard
            title="Images analysed"
            subtitle={`Per ${BUCKET_NOUN[overview.bucket]}, by organism`}
            table={
                data.length > 0 ? (
                    <DataTable
                        columns={[
                            { label: overview.bucket === 'day' ? 'Day' : `${overview.bucket} of` },
                            ...series.map((s) => ({ label: s.label, numeric: true })),
                        ]}
                        rows={data
                            .filter((d) => d.values.some((v) => v > 0))
                            .map((d) => [
                                d.title ?? d.label,
                                ...d.values.map((v) => v.toLocaleString()),
                            ])}
                    />
                ) : undefined
            }
            className="h-full"
        >
            {total === 0 ? (
                <ChartEmpty>No images were analysed in this period.</ChartEmpty>
            ) : (
                <ColumnChart
                    series={series}
                    data={data}
                    height={220}
                    totalLabel="images"
                    ariaLabel="Images analysed over time by organism"
                />
            )}
        </ChartCard>
    );
}
