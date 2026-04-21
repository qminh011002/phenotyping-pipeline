// rasterizeBoxes.ts — Batch-draw box strokes into a single canvas.
//
// The overlay renderer's per-box Konva.Rect approach breaks down at ~1k+ boxes
// because each Rect is a scene-graph node React reconciles and Konva hit-tests.
// Rasterizing every box into one canvas collapses that to a single KonvaImage
// node — a 2k-box scene costs no more than a 10-box scene.
//
// Called on annotations / selection / threshold changes, NOT on zoom/pan/hover.
// Stroke colors must match OverlayImage.tsx's STROKE_* constants.

import type { BBox } from "@/types/api";

export interface RasterizeOptions {
    imageWidth: number;
    imageHeight: number;
    boxes: BBox[];
    /** Index to skip so it can be drawn by Konva (typically the selected box). */
    excludeIndex?: number | null;
    /** Model boxes with confidence below this are not drawn. User boxes always drawn. */
    confidenceThreshold?: number;
    /** Stroke color for model-origin boxes. Matches STROKE_MODEL in OverlayImage. */
    strokeModel?: string;
    /** Stroke color for user-origin boxes. Matches STROKE_USER in OverlayImage. */
    strokeUser?: string;
    /** Image-space stroke width. 1 keeps small boxes readable at their native pixel size. */
    strokeWidth?: number;
    /**
     * Supersampling factor. The canvas is created at `imageWidth * ssaa` and
     * the drawing context is pre-scaled so all coordinate math stays in image
     * space. Konva then displays the larger bitmap at natural image size —
     * downsampling at 100% zoom (crisp), and interpolating cleanly up to
     * ~200% zoom before any blur becomes visible. Default 2 (≈ 4× memory).
     * Automatically capped so neither dimension exceeds MAX_CANVAS_DIM.
     */
    ssaa?: number;
}

const DEFAULT_STROKE_MODEL = "#22c55e";
const DEFAULT_STROKE_USER = "#f59e0b";
const DEFAULT_STROKE_WIDTH = 1;
const DEFAULT_SSAA = 2;
// Hard cap to stay under per-dimension canvas limits across browsers
// (Safari historically 4096–8192; Chrome 32767). 8192 is the safe ceiling.
const MAX_CANVAS_DIM = 8192;

/**
 * Rasterize box strokes into an HTMLCanvasElement sized to the natural image.
 * Returned canvas is intended to feed a single Konva.Image node. The Stage's
 * transform then handles zoom/pan for free.
 *
 * Performance note: we group by origin and emit two `beginPath` + `stroke`
 * calls instead of 2N — a 10-20× speedup at 2k boxes.
 */
export function rasterizeBoxes(opts: RasterizeOptions): HTMLCanvasElement {
    const {
        imageWidth,
        imageHeight,
        boxes,
        excludeIndex = null,
        confidenceThreshold = 0,
        strokeModel = DEFAULT_STROKE_MODEL,
        strokeUser = DEFAULT_STROKE_USER,
        strokeWidth = DEFAULT_STROKE_WIDTH,
    } = opts;

    const desiredSsaa = Math.max(1, opts.ssaa ?? DEFAULT_SSAA);
    // Cap ssaa so neither canvas dimension exceeds MAX_CANVAS_DIM.
    const ssaa = Math.max(
        1,
        Math.min(
            desiredSsaa,
            MAX_CANVAS_DIM / Math.max(1, imageWidth),
            MAX_CANVAS_DIM / Math.max(1, imageHeight),
        ),
    );

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(imageWidth * ssaa));
    canvas.height = Math.max(1, Math.floor(imageHeight * ssaa));

    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;

    // Pre-scale the context so ctx.rect / lineWidth / etc. are all in
    // image-space. Konva then downsamples the oversized bitmap when drawing
    // it at natural image dimensions, yielding crisp strokes under zoom.
    ctx.scale(ssaa, ssaa);
    ctx.lineWidth = strokeWidth;

    const drawPass = (origin: "model" | "user", color: string): void => {
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (let i = 0; i < boxes.length; i++) {
            if (i === excludeIndex) continue;
            const b = boxes[i];
            const isUser = b.origin === "user";
            if ((origin === "user") !== isUser) continue;
            if (!isUser && b.confidence < confidenceThreshold) continue;
            const [x1, y1, x2, y2] = b.bbox;
            const w = x2 - x1;
            const h = y2 - y1;
            if (w <= 0 || h <= 0) continue;
            ctx.rect(x1, y1, w, h);
        }
        ctx.stroke();
    };

    drawPass("model", strokeModel);
    drawPass("user", strokeUser);

    return canvas;
}
