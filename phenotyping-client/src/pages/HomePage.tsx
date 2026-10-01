// Dashboard — what has been analysed, how it compares, and what still needs
// attention. One filter row (period + organism) scopes everything below it.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Clock,
    FlaskConical,
    FolderOpen,
    Gauge,
    Images,
    Layers,
    Microscope,
    Target,
} from 'lucide-react';

import { ErrorState, PageHeader, SegmentedControl, StatTile } from '@/components/common';
import type { StatDelta } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AttentionCard } from '@/features/dashboard/components/AttentionCard';
import { BatchComparisonCard } from '@/features/dashboard/components/BatchComparisonCard';
import { ConfidenceCard } from '@/features/dashboard/components/ConfidenceCard';
import { RecentBatchesTable } from '@/features/dashboard/components/RecentBatchesTable';
import { SizeDistributionCard } from '@/features/dashboard/components/SizeDistributionCard';
import { ThroughputCard } from '@/features/dashboard/components/ThroughputCard';
import { useDashboard } from '@/features/dashboard/hooks/useDashboard';
import { formatCompact, formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { ORGANISM_ORDER, organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';
import type { DashboardKpis, Organism } from '@/types/api';

const PERIODS = [
    { value: 7, label: '7 days' },
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
    { value: 365, label: '12 months' },
    { value: 0, label: 'All time' },
];

const ORGANISM_OPTIONS: Array<{ value: Organism | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    ...ORGANISM_ORDER.map((o) => ({ value: o, label: organismMeta(o).label })),
];

function delta(
    current: number | null,
    previous: number | null | undefined,
    label: string,
    upIsGood = true,
): StatDelta | undefined {
    if (previous === undefined) return undefined; // "all time" has no baseline
    if (current == null || previous == null || previous === 0) {
        return { change: null, upIsGood, label };
    }
    return { change: (current - previous) / previous, upIsGood, label };
}

function KpiRow({
    kpis,
    previous,
    days,
    organism,
    loading,
}: {
    kpis: DashboardKpis | undefined;
    previous: DashboardKpis | null | undefined;
    days: number;
    organism: Organism | null;
    loading: boolean;
}) {
    const vs = `vs previous ${PERIODS.find((p) => p.value === days)?.label ?? 'period'}`;
    // `previous` is null for "all time" → no delta line at all.
    const prev = previous === null ? undefined : previous;
    const pick = <K extends keyof DashboardKpis>(key: K) => (prev ? prev[key] : undefined);
    const noun = organism ? organismMeta(organism).nounPlural : 'objects';

    return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatTile
                label="Batches"
                icon={Layers}
                loading={loading}
                value={formatCompact(kpis?.batches)}
                delta={kpis && delta(kpis.batches, pick('batches'), vs)}
                hint="Saved and draft batches"
            />
            <StatTile
                label="Images analysed"
                icon={Images}
                loading={loading}
                value={formatCompact(kpis?.images)}
                delta={kpis && delta(kpis.images, pick('images'), vs)}
            />
            <StatTile
                label={organism ? `${organismMeta(organism).label} counted` : 'Objects counted'}
                icon={Microscope}
                loading={loading}
                value={formatCompact(kpis?.detections)}
                delta={kpis && delta(kpis.detections, pick('detections'), vs)}
                hint={
                    kpis?.avg_count_per_image != null
                        ? `${formatNumber(kpis.avg_count_per_image)} ${noun} per image`
                        : undefined
                }
            />
            <StatTile
                label="Mean confidence"
                icon={Target}
                loading={loading}
                value={kpis?.avg_confidence != null ? formatPercent(kpis.avg_confidence) : '—'}
                delta={kpis && delta(kpis.avg_confidence, pick('avg_confidence'), vs)}
                hint="Weighted by detections"
            />
            <StatTile
                label="Time per image"
                icon={Clock}
                loading={loading}
                value={formatDuration(kpis?.avg_secs_per_image)}
                delta={
                    kpis && delta(kpis.avg_secs_per_image, pick('avg_secs_per_image'), vs, false)
                }
                hint="Mean inference time"
            />
        </div>
    );
}

function FirstRun() {
    const navigate = useNavigate();
    return (
        <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <FlaskConical className="size-6" aria-hidden />
            </span>
            <h2 className="text-base font-semibold">No analyses yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
                Upload a set of images to count eggs, neonates, larvae or pupae. Throughput, batch
                comparisons and size distributions will appear here as you go.
            </p>
            <Button className="mt-2" onClick={() => navigate('/analyze')}>
                <FlaskConical />
                Start analysis
            </Button>
        </div>
    );
}

export default function HomePage() {
    const navigate = useNavigate();
    const [days, setDays] = useState(30);
    const [organismFilter, setOrganismFilter] = useState<Organism | 'all'>('all');
    const organism = organismFilter === 'all' ? null : organismFilter;

    const query = useDashboard(days, organism);
    const overview = query.data;
    const loading = query.isPending;
    // Previous slice still on screen while the new one loads.
    const stale = query.isPlaceholderData;
    const isEmptyAccount =
        overview !== undefined &&
        overview.recent_analyses.length === 0 &&
        overview.kpis.batches === 0;

    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-6">
                    <PageHeader
                        title="Dashboard"
                        description="Throughput, batch comparisons and measured sizes across your analyses."
                        actions={
                            <>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => navigate('/recorded')}
                                >
                                    <FolderOpen />
                                    Recorded
                                </Button>
                                <Button size="sm" onClick={() => navigate('/analyze')}>
                                    <FlaskConical />
                                    Start analysis
                                </Button>
                            </>
                        }
                    >
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <SegmentedControl
                                aria-label="Period"
                                value={days}
                                onChange={setDays}
                                options={PERIODS}
                            />
                            <SegmentedControl
                                aria-label="Organism"
                                value={organismFilter}
                                onChange={setOrganismFilter}
                                options={ORGANISM_OPTIONS}
                            />
                            {query.isFetching && !loading && (
                                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <Gauge className="size-3.5 animate-pulse" aria-hidden />
                                    Updating…
                                </span>
                            )}
                        </div>
                    </PageHeader>

                    {query.isError && !overview ? (
                        <div className="panel">
                            <ErrorState
                                title="Failed to load dashboard"
                                message={String(query.error)}
                                onRetry={() => void query.refetch()}
                            />
                        </div>
                    ) : isEmptyAccount ? (
                        <FirstRun />
                    ) : (
                        <div
                            className={cn(
                                'flex flex-col gap-4 transition-opacity duration-200',
                                stale && 'opacity-60',
                            )}
                            aria-busy={stale}
                        >
                            <KpiRow
                                kpis={overview?.kpis}
                                previous={overview?.previous}
                                days={days}
                                organism={organism}
                                loading={loading}
                            />

                            {overview ? (
                                <>
                                    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
                                        <ThroughputCard overview={overview} />
                                        <AttentionCard attention={overview.attention} />
                                    </div>
                                    <BatchComparisonCard overview={overview} />
                                    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
                                        <SizeDistributionCard overview={overview} />
                                        <ConfidenceCard overview={overview} organism={organism} />
                                    </div>
                                    <RecentBatchesTable
                                        recent={overview.recent_analyses}
                                        extras={overview.batches}
                                    />
                                </>
                            ) : (
                                <>
                                    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
                                        <Skeleton className="h-80 rounded-xl" />
                                        <Skeleton className="h-80 rounded-xl" />
                                    </div>
                                    <Skeleton className="h-64 rounded-xl" />
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
