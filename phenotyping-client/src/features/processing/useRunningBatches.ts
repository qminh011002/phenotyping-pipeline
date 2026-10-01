// Every analysis run in flight for this account — the one this tab is driving
// and any started from another tab or device.
//
// The server's list of `processing` batches is the source of truth for *which*
// runs exist and when each began, so the tracker survives reloads and shows
// runs this tab did not start. The run this tab drives is enriched from the
// processing store, which knows the live stage and updates per image rather
// than per poll.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { listAnalyses } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { useProcessingStore } from '@/stores/processingStore';
import type { AnalysisBatchSummary } from '@/types/api';

/** Poll interval while at least one run is in flight. */
const ACTIVE_POLL_MS = 3000;
/** Idle poll — how soon a run started on another device shows up here. */
const IDLE_POLL_MS = 20_000;

export const RUNNING_BATCHES_KEY = ['running-batches'] as const;

export interface RunningBatch {
    /** Batch id; null only in the first moments, before the server has one. */
    id: string | null;
    name: string;
    organism: string;
    processed: number;
    total: number;
    /** Start of the run, epoch ms. */
    startedAtMs: number;
    /** True when this tab drives the run (it owns the files being uploaded). */
    local: boolean;
    /** Live pipeline stage — local runs only. */
    stage: string | null;
    /** File being processed right now — local runs only. */
    currentFile: string | null;
    failed: number;
    /** Adding images to an existing batch rather than creating one. */
    appending: boolean;
}

function fromServer(batch: AnalysisBatchSummary): RunningBatch {
    return {
        id: batch.id,
        name: batch.name || 'Untitled batch',
        organism: batch.organism_type,
        processed: batch.processed_image_count,
        total: batch.total_image_count,
        startedAtMs: new Date(batch.processing_started_at ?? batch.created_at).getTime(),
        local: false,
        stage: null,
        currentFile: null,
        failed: 0,
        appending: false,
    };
}

export function useRunningBatches(): RunningBatch[] {
    const authed = useAuthStore((s) => s.status === 'authed');
    const isProcessing = useProcessingStore((s) => s.isProcessing);
    const activeBatchId = useProcessingStore((s) => s.activeBatchId);
    const processedCount = useProcessingStore((s) => s.processedCount);
    const totalImages = useProcessingStore((s) => s.totalImages);
    const images = useProcessingStore((s) => s.images);
    const stage = useProcessingStore((s) => s.stage);
    const projectName = useProcessingStore((s) => s.projectName);
    const organism = useProcessingStore((s) => s.organism);
    const appendingToName = useProcessingStore((s) => s.appendingToName);
    const runStartedAtMs = useProcessingStore((s) => s.runStartedAtMs);
    const completedBatchId = useProcessingStore((s) => s.completedBatchId);

    const query = useQuery({
        queryKey: RUNNING_BATCHES_KEY,
        enabled: authed,
        queryFn: ({ signal }) =>
            listAnalyses(
                {
                    statuses: ['processing'],
                    page: 1,
                    pageSize: 50,
                    sort: 'created_at',
                    order: 'asc',
                },
                signal,
            ),
        refetchInterval: (q) =>
            (q.state.data?.items.length ?? 0) > 0 || isProcessing ? ACTIVE_POLL_MS : IDLE_POLL_MS,
        staleTime: 0,
    });

    // This tab's run starting or ending changes the list right now — don't
    // wait for the next poll to find out.
    const { refetch } = query;
    useEffect(() => {
        if (authed) void refetch();
    }, [authed, isProcessing, activeBatchId, refetch]);

    return useMemo(() => {
        const server = (query.data?.items ?? [])
            // Just finished here; the cached poll may not know yet.
            .filter((b) => b.id !== completedBatchId)
            .map(fromServer);
        if (!isProcessing) return server;

        let current: string | null = null;
        let failed = 0;
        for (const image of images) {
            if (image.status === 'processing') current = image.filename;
            else if (image.status === 'error') failed += 1;
        }
        const known = server.find((b) => b.id === activeBatchId);
        const local: RunningBatch = {
            id: activeBatchId,
            name: known?.name ?? appendingToName ?? projectName?.trim() ?? 'New analysis',
            organism: known?.organism ?? organism,
            // This run's own files — for an append, the new images only.
            processed: processedCount,
            total: totalImages,
            // The server's start time survives a reload; the store's covers
            // the seconds before the first poll comes back.
            startedAtMs: known?.startedAtMs ?? runStartedAtMs ?? Date.now(),
            local: true,
            stage,
            currentFile: current,
            failed,
            appending: appendingToName !== null,
        };
        return [local, ...server.filter((b) => b.id !== activeBatchId)];
    }, [
        query.data,
        isProcessing,
        activeBatchId,
        processedCount,
        totalImages,
        images,
        stage,
        projectName,
        organism,
        appendingToName,
        runStartedAtMs,
        completedBatchId,
    ]);
}

/** Wall-clock `Date.now()` that re-renders every second while `active`. */
export function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

/** Seconds left at the pace so far; null until one image is done. */
export function estimateRemaining(
    batch: Pick<RunningBatch, 'processed' | 'total' | 'startedAtMs'>,
    now: number,
): number | null {
    if (batch.processed <= 0 || batch.total <= batch.processed) return null;
    const elapsed = (now - batch.startedAtMs) / 1000;
    if (elapsed <= 0) return null;
    return (elapsed / batch.processed) * (batch.total - batch.processed);
}
