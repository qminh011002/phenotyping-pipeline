// BatchTracker — the floating "running analyses" card in the bottom-right
// corner. Mounted once for the whole app, so it follows the operator to any
// page while a run is in flight.
//
// One row per running batch: name, organism, progress, a clock that ticks
// from the run's real start time, the live stage (for the run this tab
// drives) and a time-left estimate. Clicking a row opens that batch. When a
// run ends, a toast says how it went and links to the result.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

import { OrganismBadge } from '@/components/common';
import { toast } from '@/components/ui/sonner';
import { batchPath } from '@/features/recorded/lib/paths';
import { formatCount, formatElapsed, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { getAnalysisDetail } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';

import { RunControls } from './RunControls';
import {
    estimateRemaining,
    useNow,
    useRunningBatches,
    type RunningBatch,
} from './useRunningBatches';

/** The processing page already shows the run in full; anon pages have no runs. */
const HIDDEN_ON = new Set(['/analyze/processing', '/login', '/register']);

/** Where a row leads: the live run page for this tab's run, else the batch. */
function runPath(batch: RunningBatch): string {
    return batch.local || !batch.id ? '/analyze/processing' : batchPath(batch.id);
}

export function BatchTracker() {
    const authed = useAuthStore((s) => s.status === 'authed');
    const location = useLocation();
    const navigate = useNavigate();
    const batches = useRunningBatches();
    const [collapsed, setCollapsed] = useState(false);
    const now = useNow(batches.length > 0);
    useFinishedNotices(batches);

    if (!authed || batches.length === 0 || HIDDEN_ON.has(location.pathname)) return null;

    const processed = batches.reduce((sum, b) => sum + b.processed, 0);
    const total = batches.reduce((sum, b) => sum + b.total, 0);
    const overall = total > 0 ? Math.round((processed / total) * 100) : 0;

    return (
        <section
            aria-label="Running analyses"
            className="floating-panel fixed right-4 bottom-4 z-50 w-[21rem] max-w-[calc(100vw-2rem)] overflow-hidden"
        >
            <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={!collapsed}
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left outline-none hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05]"
            >
                <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                    {batches.length === 1
                        ? 'Analysis running'
                        : `${batches.length} analyses running`}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {overall}%
                </span>
                <ChevronDown
                    className={cn(
                        'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                        collapsed && 'rotate-180',
                    )}
                    aria-hidden
                />
            </button>

            {!collapsed && (
                <ul className="max-h-[min(24rem,60vh)] divide-y divide-border overflow-y-auto border-t border-border">
                    {batches.map((batch) => (
                        <li key={batch.id ?? 'starting'}>
                            <TrackerRow
                                batch={batch}
                                now={now}
                                onOpen={() => navigate(runPath(batch))}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function TrackerRow({
    batch,
    now,
    onOpen,
}: {
    batch: RunningBatch;
    now: number;
    onOpen: () => void;
}) {
    const pct = batch.total > 0 ? Math.min(100, (batch.processed / batch.total) * 100) : 0;
    const elapsed = (now - batch.startedAtMs) / 1000;
    const remaining = batch.paused ? null : estimateRemaining(batch, now);
    const noun = batch.appending ? 'new image' : 'image';
    const detail = batch.local
        ? (batch.stage ?? (batch.currentFile ? `Processing ${batch.currentFile}` : 'Starting…'))
        : 'Started in another tab or device';

    const openTitle = batch.local ? 'Open the live run' : 'Open this batch';

    return (
        // Two siblings, not one big button: the controls must not nest inside
        // the element that opens the batch.
        <div className="group flex flex-col gap-2 px-3.5 py-3 transition-colors duration-150 hover:bg-foreground/[0.03]">
            <div className="flex min-w-0 items-center gap-2">
                <button
                    type="button"
                    onClick={onOpen}
                    title={openTitle}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                    <span className="min-w-0 truncate text-[13px] font-medium" title={batch.name}>
                        {batch.name}
                    </span>
                    <OrganismBadge organism={batch.organism} />
                    <ChevronRight
                        className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5"
                        aria-hidden
                    />
                </button>
                <RunControls run={batch} compact />
            </div>

            {/* The same link again for the pointer; the name above serves keyboards. */}
            <button
                type="button"
                tabIndex={-1}
                onClick={onOpen}
                title={openTitle}
                className="flex flex-col gap-2 text-left outline-none"
            >
                <span
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={`${batch.name} progress`}
                    aria-valuemin={0}
                    aria-valuemax={batch.total}
                    aria-valuenow={batch.processed}
                >
                    <span
                        className={cn(
                            'block h-full rounded-full transition-[width] duration-300 ease-out',
                            batch.paused ? 'bg-muted-foreground/50' : 'bg-primary',
                        )}
                        style={{ width: `${pct}%` }}
                    />
                </span>

                <span className="flex w-full items-center justify-between gap-3 text-xs tabular-nums text-muted-foreground">
                    <span>
                        <span className="font-medium text-foreground">
                            {formatCount(batch.processed)}
                        </span>{' '}
                        of {formatCount(batch.total)} {pluralize(batch.total, noun)} ·{' '}
                        {Math.round(pct)}%
                        {batch.failed > 0 && (
                            <span className="text-destructive"> · {batch.failed} failed</span>
                        )}
                    </span>
                    <span className="shrink-0" title="Time since this run started">
                        {formatElapsed(elapsed)}
                    </span>
                </span>

                <span className="flex w-full items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate" title={detail}>
                        {detail}
                    </span>
                    {remaining !== null && (
                        <span className="shrink-0 tabular-nums">
                            ≈ {formatElapsed(remaining)} left
                        </span>
                    )}
                </span>
            </button>
        </div>
    );
}

/** Toast once for every run that leaves the running set, and keep the views
 *  that list batches in step with runs starting and ending. */
function useFinishedNotices(batches: RunningBatch[]) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const previous = useRef<Map<string, RunningBatch>>(new Map());

    useEffect(() => {
        const current = new Map<string, RunningBatch>();
        for (const batch of batches) if (batch.id) current.set(batch.id, batch);
        const finished = [...previous.current.values()].filter((b) => !current.has(b.id!));
        const started = [...current.keys()].some((id) => !previous.current.has(id));
        previous.current = current;
        // A run appearing (maybe from another device) or ending changes what
        // the Recorded list should show.
        if (started || finished.length > 0) {
            void queryClient.invalidateQueries({ queryKey: ['recorded-batches'] });
        }
        if (finished.length === 0) return;

        void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
        for (const batch of finished) {
            const id = batch.id!;
            // Already looking at it (the run page hands over to its results).
            const here = window.location.pathname + window.location.search;
            const watching = here.includes(id) || here.startsWith('/analyze/processing');
            void queryClient.invalidateQueries({ queryKey: ['analysis-detail', id] });
            // The list only says the run is gone; the batch says how it ended.
            getAnalysisDetail(id, undefined, { includeAnnotations: false })
                .then((detail) => {
                    if (watching) return;
                    const open = { label: 'Open', onClick: () => navigate(batchPath(id)) };
                    if (detail.status === 'failed') {
                        // The operator cancelled it themselves — nothing to report.
                        if (detail.failure_reason?.startsWith('User ')) return;
                        toast.error(`Analysis failed — ${detail.name}`, {
                            description: detail.failure_reason ?? undefined,
                            action: open,
                        });
                        return;
                    }
                    const failed = detail.images.filter((i) => i.status === 'failed').length;
                    toast.success(`Analysis finished — ${detail.name}`, {
                        description:
                            `${formatCount(detail.processed_image_count)} ${pluralize(detail.processed_image_count, 'image')} processed` +
                            (failed > 0 ? ` · ${failed} failed` : ''),
                        action: open,
                    });
                })
                .catch(() => {
                    // Deleted or discarded: it simply leaves the tracker.
                });
        }
    }, [batches, navigate, queryClient]);
}
