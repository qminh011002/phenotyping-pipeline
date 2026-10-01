// How confident the model was, image by image: a histogram of each image's
// mean detection confidence. The left tail is what needs a second look.

import { organismMeta } from '@/lib/organism';
import type { DashboardOverview, Organism } from '@/types/api';

import { ChartCard, ChartEmpty, DataTable } from './ChartCard';
import { ColumnChart } from './ColumnChart';

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function ConfidenceCard({
    overview,
    organism,
}: {
    overview: DashboardOverview;
    organism: Organism | null;
}) {
    const bins = overview.confidence_histogram;
    const total = bins.reduce((sum, b) => sum + b.count, 0);
    const low = overview.attention.low_confidence_images;
    // An aggregate over every organism is not any one organism — keep it in
    // neutral ink. Filtered to one organism, it wears that organism's colour.
    const color = organism
        ? organismMeta(organism).color
        : 'color-mix(in oklab, var(--foreground) 55%, transparent)';

    return (
        <ChartCard
            title="Model confidence"
            subtitle="Images by their mean detection confidence"
            table={
                total > 0 ? (
                    <DataTable
                        columns={[{ label: 'Confidence' }, { label: 'Images', numeric: true }]}
                        rows={bins
                            .filter((b) => b.count > 0)
                            .map((b) => [
                                `${pct(b.start)}–${pct(b.end)}`,
                                b.count.toLocaleString(),
                            ])}
                    />
                ) : undefined
            }
            className="h-full"
        >
            {total === 0 ? (
                <ChartEmpty>No detections in this period.</ChartEmpty>
            ) : (
                <>
                    <ColumnChart
                        series={[{ key: 'images', label: 'images', color }]}
                        data={bins.map((b) => ({
                            key: String(b.start),
                            label: pct(b.start),
                            title: `${pct(b.start)}–${pct(b.end)} confidence`,
                            values: [b.count],
                        }))}
                        height={150}
                        ariaLabel="Distribution of per-image mean confidence"
                    />
                    <p className="mt-3 text-xs text-muted-foreground">
                        {low === 0 ? (
                            'No image averages below 50% confidence.'
                        ) : (
                            <>
                                <span className="font-medium text-foreground tabular-nums">
                                    {low.toLocaleString()}
                                </span>{' '}
                                {low === 1 ? 'image averages' : 'images average'} below 50% — worth
                                reviewing by hand.
                            </>
                        )}
                    </p>
                </>
            )}
        </ChartCard>
    );
}
