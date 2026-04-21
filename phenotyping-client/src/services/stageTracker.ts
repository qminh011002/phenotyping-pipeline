// Subscribes to the /logs/stream WebSocket, filters for "analysis.stage"
// events tied to the currently running batch, and writes a human-readable
// label into the processing store so the UI can display the current phase.

import { getBaseUrl } from "./http";
import { getRunningBatchId } from "./processingManager";
import { LogStreamClient } from "./websocket";
import { useProcessingStore } from "@/stores/processingStore";
import type { LogEntry } from "@/types/api";

const STAGE_LABELS: Record<string, string> = {
    "image.decode": "Decoding image",
    "image.tile": "Slicing into tiles",
    "image.detect": "Detecting objects",
    "image.dedup": "Merging detections",
    "image.draw": "Drawing overlay",
    "image.save": "Saving overlay",
};

function composeStageText(code: string, filename?: string): string {
    const base = STAGE_LABELS[code] ?? code;
    const state = useProcessingStore.getState();
    const index = state.processedCount + state.images.filter((i) => i.status === "error").length + 1;
    const total = state.totalImages;
    const indexPart = total > 0 ? ` (${Math.min(index, total)}/${total})` : "";
    const filePart = filename ? ` — ${filename}` : "";
    return `${base}${filePart}${indexPart}…`;
}

function isStageEntry(entry: LogEntry): boolean {
    const ctx = entry.context ?? {};
    return ctx.event === "analysis.stage" && typeof ctx.stage === "string";
}

let client: LogStreamClient | null = null;

export function startStageTracker(): void {
    if (client) return;
    client = new LogStreamClient({
        onLog: (entry) => {
            if (!isStageEntry(entry)) return;
            const ctx = entry.context as { stage: string; batch_id?: string; filename?: string };
            const active = getRunningBatchId();
            if (!active || ctx.batch_id !== active) return;
            useProcessingStore.getState().setStage(composeStageText(ctx.stage, ctx.filename));
        },
        onHeartbeat: () => {
            /* no-op */
        },
    });
    client.connect(getBaseUrl());
}

export function stopStageTracker(): void {
    if (!client) return;
    client.disconnect();
    client = null;
}
