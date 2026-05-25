// Shared mm-per-pixel math. Mirrors backend `_compute_factors_from_ordered`:
// average opposing sides → w_px / h_px → mm/px factors.

import type { Point2D } from '@/types/api';

export type Corners = [Point2D, Point2D, Point2D, Point2D]; // TL, TR, BR, BL

const dist = (a: Point2D, b: Point2D) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function sideLengths(c: Corners): [number, number, number, number] {
    return [dist(c[0], c[1]), dist(c[1], c[2]), dist(c[2], c[3]), dist(c[3], c[0])];
}

export function computeFactors(
    c: Corners,
    realWmm: number,
    realHmm: number,
): { mm_per_px_x: number; mm_per_px_y: number } | null {
    const s = sideLengths(c);
    const wPx = (s[0] + s[2]) / 2;
    const hPx = (s[1] + s[3]) / 2;
    if (wPx <= 0 || hPx <= 0) return null;
    return { mm_per_px_x: realWmm / wPx, mm_per_px_y: realHmm / hPx };
}

export const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;
