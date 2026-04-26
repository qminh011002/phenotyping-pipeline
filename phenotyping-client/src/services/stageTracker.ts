// Subscribes to the dedicated /ws/stages WebSocket and writes a human-readable
// label for the currently-running batch into the processing store so the UI
// can display the current phase of inference.

import { getBaseUrl } from "./http";
import { getRunningBatchId } from "./processingManager";
import { useProcessingStore } from "@/stores/processingStore";

const STAGE_LABELS: Record<string, string> = {
    "image.decode": "Decoding image",
    "image.tile": "Slicing into tiles",
    "image.detect": "Detecting objects",
    "image.dedup": "Merging detections",
    "image.draw": "Drawing overlay",
    "image.save": "Saving overlay",
};

interface StageEvent {
    stage: string;
    batch_id: string;
    filename?: string;
    organism?: string;
}

function composeStageText(code: string, filename?: string): string {
    const base = STAGE_LABELS[code] ?? code;
    const state = useProcessingStore.getState();
    const index = state.processedCount + state.images.filter((i) => i.status === "error").length + 1;
    const total = state.totalImages;
    const indexPart = total > 0 ? ` (${Math.min(index, total)}/${total})` : "";
    const filePart = filename ? ` — ${filename}` : "";
    return `${base}${filePart}${indexPart}…`;
}

function toWsUrl(base: string): string {
    const u = base.replace(/^http/, "ws").replace(/\/$/, "");
    return `${u}/ws/stages`;
}

let ws: WebSocket | null = null;
let opening = false;
let stopped = true;
let reconnectTimer: number | null = null;
let reconnectDelay = 500;

const DEV = import.meta.env.DEV;

function isStageEvent(value: unknown): value is StageEvent {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return typeof v.stage === "string" && typeof v.batch_id === "string";
}

function clearReconnect(): void {
    if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect(): void {
    if (stopped) return;
    clearReconnect();
    const delay = Math.min(reconnectDelay, 30_000) + Math.random() * 1000;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        openSocket();
    }, delay);
}

function openSocket(): void {
    if (stopped) return;
    if (opening || ws) return;
    opening = true;
    const url = toWsUrl(getBaseUrl());
    if (DEV) console.debug("[stageTracker] connecting to", url);
    let sock: WebSocket;
    try {
        sock = new WebSocket(url);
    } catch (e) {
        opening = false;
        if (DEV) console.warn("[stageTracker] ws construct failed:", e);
        scheduleReconnect();
        return;
    }
    ws = sock;

    sock.onopen = () => {
        opening = false;
        reconnectDelay = 500;
        if (DEV) console.info("[stageTracker] ✅ connected to", url);
    };
    sock.onmessage = (ev) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(ev.data as string);
        } catch (e) {
            if (DEV) console.warn("[stageTracker] bad frame:", ev.data, e);
            return;
        }
        if (!isStageEvent(parsed)) {
            if (DEV) console.warn("[stageTracker] invalid event shape:", parsed);
            return;
        }
        const evt = parsed;
        const active = getRunningBatchId();
        if (!active) return;
        if (evt.batch_id !== active) return;
        if (DEV) console.debug("[stageTracker] 📥", evt.stage, "—", evt.filename);
        useProcessingStore.getState().setStage(composeStageText(evt.stage, evt.filename));
    };
    sock.onerror = (e) => {
        if (DEV) console.warn("[stageTracker] ws error:", e);
    };
    sock.onclose = (e) => {
        if (DEV) console.debug("[stageTracker] ws closed:", e.code, e.reason);
        opening = false;
        if (ws === sock) ws = null;
        scheduleReconnect();
    };
}

export function startStageTracker(): void {
    if (!stopped && (ws || opening)) return;
    stopped = false;
    reconnectDelay = 500;
    openSocket();
}

export function stopStageTracker(): void {
    stopped = true;
    opening = false;
    clearReconnect();
    if (ws) {
        try {
            ws.close();
        } catch {
            /* ignore */
        }
        ws = null;
    }
}
