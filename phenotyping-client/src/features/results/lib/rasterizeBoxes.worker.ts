// rasterizeBoxes.worker.ts — off-main-thread box rasterizer.
//
// Receives box geometry + params, draws strokes into an OffscreenCanvas, and
// transfers an ImageBitmap back. The main thread swaps the bitmap into a
// Konva.Image without ever blocking on canvas allocation or stroke work.
//
// Stroke colors and defaults must stay in sync with rasterizeBoxes.ts.

import type { BBox } from "@/types/api";

interface RasterizeRequest {
    id: number;
    imageWidth: number;
    imageHeight: number;
    boxes: BBox[];
    excludeIndex: number | null;
    confidenceThreshold: number;
    strokeModel: string;
    strokeUser: string;
    strokeWidth: number;
    ssaa: number;
    /** When > 0, labels are drawn above each visible box at this image-space
     *  font size. When 0 or undefined, labels are skipped. */
    labelFontSize?: number;
    labelBg?: string;
    labelFg?: string;
}

interface RasterizeResponse {
    id: number;
    bitmap: ImageBitmap;
}

const MAX_CANVAS_DIM = 8192;

function rasterize(req: RasterizeRequest): ImageBitmap {
    const {
        imageWidth,
        imageHeight,
        boxes,
        excludeIndex,
        confidenceThreshold,
        strokeModel,
        strokeUser,
        strokeWidth,
    } = req;

    const ssaa = Math.max(
        1,
        Math.min(
            Math.max(1, req.ssaa),
            MAX_CANVAS_DIM / Math.max(1, imageWidth),
            MAX_CANVAS_DIM / Math.max(1, imageHeight),
        ),
    );

    const w = Math.max(1, Math.floor(imageWidth * ssaa));
    const h = Math.max(1, Math.floor(imageHeight * ssaa));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas.transferToImageBitmap();

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
            const bw = x2 - x1;
            const bh = y2 - y1;
            if (bw <= 0 || bh <= 0) continue;
            ctx.rect(x1, y1, bw, bh);
        }
        ctx.stroke();
    };

    drawPass("model", strokeModel);
    drawPass("user", strokeUser);

    // Labels — drawn last so they sit on top of strokes. Text layout + fill
    // on OffscreenCanvas is far cheaper than Konva's per-node Tag+Text layout,
    // and running off-thread means thousands of labels cost the UI nothing.
    const labelFontSize = req.labelFontSize ?? 0;
    if (labelFontSize > 0) {
        const padding = Math.max(1, labelFontSize * 0.15);
        const lineH = labelFontSize * 1.2;
        const labelH = lineH + padding * 2;
        ctx.font = `bold ${labelFontSize}px sans-serif`;
        ctx.textBaseline = "top";
        const labelBg = req.labelBg ?? "rgba(255,255,255,0.95)";
        const labelFg = req.labelFg ?? "#f59e0b";

        for (let i = 0; i < boxes.length; i++) {
            if (i === excludeIndex) continue;
            const b = boxes[i];
            const isUser = b.origin === "user";
            if (!isUser && b.confidence < confidenceThreshold) continue;
            const [x1, y1, x2, y2] = b.bbox;
            const bw = x2 - x1;
            const bh = y2 - y1;
            if (bw <= 0 || bh <= 0) continue;

            const text = b.label || "object";
            const textW = ctx.measureText(text).width;
            const labelW = textW + padding * 2;
            const flipInside = y1 - labelH < 0;
            const ly = flipInside ? y1 : y1 - labelH;
            const lx = Math.max(0, Math.min(x1, imageWidth - labelW));

            ctx.fillStyle = labelBg;
            ctx.fillRect(lx, ly, labelW, labelH);
            ctx.fillStyle = labelFg;
            ctx.fillText(text, lx + padding, ly + padding);
        }
    }

    return canvas.transferToImageBitmap();
}

self.onmessage = (e: MessageEvent<RasterizeRequest>) => {
    const req = e.data;
    const bitmap = rasterize(req);
    const response: RasterizeResponse = { id: req.id, bitmap };
    (self as unknown as Worker).postMessage(response, [bitmap]);
};

export {};
