// The latest batches of any status, as a compact table. Rows open the batch.

import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

import { OrganismBadge, StatusBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import { formatCount, formatDateTime, formatNumber, formatPercent, timeAgo } from '@/lib/format';
import { organismMeta } from '@/lib/organism';
import type { AnalysisBatchSummary, DashboardBatchRow } from '@/types/api';

interface RecentBatchesTableProps {
    recent: AnalysisBatchSummary[];
    /** Per-batch extras (mean length) keyed by id, when known. */
    extras: DashboardBatchRow[];
}

export function RecentBatchesTable({ recent, extras }: RecentBatchesTableProps) {
    const navigate = useNavigate();
    const extraById = new Map(extras.map((e) => [e.id, e]));

    return (
        <section className="panel min-w-0">
            <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-3">
                <div>
                    <h2 className="text-sm font-semibold">Recent batches</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        Your latest runs, newest first
                    </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => navigate('/recorded')}>
                    View all
                    <ArrowRight />
                </Button>
            </header>
            {recent.length === 0 ? (
                <p className="px-5 pb-6 text-sm text-muted-foreground">No batches yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[44rem] text-left text-sm">
                        <thead className="border-y border-border bg-muted/50 text-xs text-muted-foreground">
                            <tr>
                                <th scope="col" className="px-5 py-2 font-medium">
                                    Batch
                                </th>
                                <th scope="col" className="px-3 py-2 font-medium">
                                    Status
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    Images
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    Count
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    Per image
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    Confidence
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    Mean length
                                </th>
                                <th scope="col" className="px-5 py-2 text-right font-medium">
                                    Created
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {recent.map((batch) => {
                                const extra = extraById.get(batch.id);
                                const perImage =
                                    batch.total_count != null && batch.processed_image_count > 0
                                        ? batch.total_count / batch.processed_image_count
                                        : null;
                                const open = () => navigate(`/recorded?batch=${batch.id}`);
                                return (
                                    <tr
                                        key={batch.id}
                                        tabIndex={0}
                                        role="link"
                                        aria-label={`Open ${batch.name}`}
                                        onClick={open}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') open();
                                        }}
                                        className="cursor-pointer transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:bg-muted/70"
                                    >
                                        <td className="max-w-64 px-5 py-2.5">
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className="truncate font-medium"
                                                    title={batch.name}
                                                >
                                                    {batch.name || 'Untitled batch'}
                                                </span>
                                                <OrganismBadge organism={batch.organism_type} />
                                            </div>
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <StatusBadge status={batch.status} />
                                        </td>
                                        <td className="px-3 py-2.5 text-right tabular-nums">
                                            {formatCount(batch.processed_image_count)}
                                        </td>
                                        <td
                                            className="px-3 py-2.5 text-right tabular-nums"
                                            title={
                                                batch.total_count != null
                                                    ? `${batch.total_count.toLocaleString()} ${organismMeta(batch.organism_type).nounPlural}`
                                                    : undefined
                                            }
                                        >
                                            {formatCount(batch.total_count)}
                                        </td>
                                        <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">
                                            {formatNumber(perImage)}
                                        </td>
                                        <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">
                                            {formatPercent(batch.avg_confidence)}
                                        </td>
                                        <td className="px-3 py-2.5 text-right text-muted-foreground tabular-nums">
                                            {extra?.mean_length_mm != null
                                                ? `${formatNumber(extra.mean_length_mm, 2)} mm`
                                                : '—'}
                                        </td>
                                        <td
                                            className="px-5 py-2.5 text-right whitespace-nowrap text-muted-foreground"
                                            title={formatDateTime(batch.created_at)}
                                        >
                                            {timeAgo(batch.created_at)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
