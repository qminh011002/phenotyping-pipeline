// polygonOps — pure geometry helpers for the larvae polygon editor.
//
// All inputs/outputs are in image-native pixel space. Polygons are arrays of
// (x, y) tuples; ≥3 vertices form a valid closed polygon (first vertex is not
// repeated at the end).

import type { LarvaePolygon, Point2D } from '@/types/api';

export const MIN_POLYGON_VERTICES = 3;
export const MIN_EDGE_LENGTH_PX = 4;

/** Clamp a vertex to the image bounds. */
export function clampVertex(
    [x, y]: Point2D,
    width: number,
    height: number,
): Point2D {
    return [
        Math.max(0, Math.min(width, x)),
        Math.max(0, Math.min(height, y)),
    ];
}

/** Replace vertex `idx` with `next`. Returns a new polygon. */
export function moveVertex(
    poly: LarvaePolygon,
    idx: number,
    next: Point2D,
): LarvaePolygon {
    if (idx < 0 || idx >= poly.length) return poly;
    const out = poly.slice();
    out[idx] = next;
    return out;
}

/** Translate every vertex by (dx, dy). Returns a new polygon. */
export function translatePolygon(
    poly: LarvaePolygon,
    dx: number,
    dy: number,
): LarvaePolygon {
    if (dx === 0 && dy === 0) return poly;
    return poly.map(([x, y]) => [x + dx, y + dy] as Point2D);
}

/**
 * Insert a new vertex at the click point on edge `edgeIdx` (the edge from
 * vertex `edgeIdx` to vertex `edgeIdx + 1`, wrapping). Returns the new polygon
 * and the index of the inserted vertex.
 */
export function insertVertex(
    poly: LarvaePolygon,
    edgeIdx: number,
    point: Point2D,
): { polygon: LarvaePolygon; insertedAt: number } {
    if (edgeIdx < 0 || edgeIdx >= poly.length) {
        return { polygon: poly, insertedAt: -1 };
    }
    const insertedAt = edgeIdx + 1;
    const out = [
        ...poly.slice(0, insertedAt),
        point,
        ...poly.slice(insertedAt),
    ];
    return { polygon: out, insertedAt };
}

/**
 * Remove vertex at `idx`. Returns the original polygon unchanged if the
 * deletion would leave fewer than 3 vertices.
 */
export function deleteVertex(
    poly: LarvaePolygon,
    idx: number,
): LarvaePolygon {
    if (poly.length <= MIN_POLYGON_VERTICES) return poly;
    if (idx < 0 || idx >= poly.length) return poly;
    return [...poly.slice(0, idx), ...poly.slice(idx + 1)];
}

/** Whether a polygon has enough vertices to be valid. */
export function isValidPolygon(poly: LarvaePolygon): boolean {
    return poly.length >= MIN_POLYGON_VERTICES;
}

/** Squared distance from point `p` to segment `ab`. */
function sqSegDist(p: Point2D, a: Point2D, b: Point2D): number {
    let x = a[0];
    let y = a[1];
    let dx = b[0] - x;
    let dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
        const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
        if (t > 1) {
            x = b[0];
            y = b[1];
        } else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
}

/**
 * Ramer–Douglas–Peucker simplification on a closed polygon. Operates on a
 * doubled-up open polyline (first vertex repeated at end) so the closing edge
 * participates in the recursion. Tolerance is in image pixels.
 *
 * Always returns at least `MIN_POLYGON_VERTICES` vertices; if RDP would reduce
 * below that, the original polygon is returned unchanged.
 */
export function simplifyPolygon(
    poly: LarvaePolygon,
    tolerance: number,
): LarvaePolygon {
    if (tolerance <= 0 || poly.length <= MIN_POLYGON_VERTICES) return poly;
    const sqTol = tolerance * tolerance;

    // Treat the closed polygon as an open polyline by duplicating the start.
    const open: Point2D[] = [...poly, poly[0]];
    const keep = new Array<boolean>(open.length).fill(false);
    keep[0] = true;
    keep[open.length - 1] = true;

    const stack: Array<[number, number]> = [[0, open.length - 1]];
    while (stack.length > 0) {
        const [first, last] = stack.pop()!;
        let maxSq = 0;
        let maxIdx = -1;
        for (let i = first + 1; i < last; i++) {
            const d = sqSegDist(open[i], open[first], open[last]);
            if (d > maxSq) {
                maxSq = d;
                maxIdx = i;
            }
        }
        if (maxSq > sqTol && maxIdx !== -1) {
            keep[maxIdx] = true;
            stack.push([first, maxIdx], [maxIdx, last]);
        }
    }

    // Drop the duplicated closing vertex.
    const simplified: LarvaePolygon = [];
    for (let i = 0; i < open.length - 1; i++) {
        if (keep[i]) simplified.push(open[i]);
    }
    return simplified.length >= MIN_POLYGON_VERTICES ? simplified : poly;
}

/** Project point `p` onto the segment `ab` and return the closest point. */
export function projectOnSegment(
    p: Point2D,
    a: Point2D,
    b: Point2D,
): Point2D {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return [a[0], a[1]];
    const t = Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
    );
    return [a[0] + dx * t, a[1] + dy * t];
}

/**
 * Find the polygon edge nearest to `point` (within `maxDistPx`) and return
 * the edge index plus the projection point. Returns null if no edge is close
 * enough.
 */
export function findClosestEdge(
    poly: LarvaePolygon,
    point: Point2D,
    maxDistPx: number,
): { edgeIdx: number; projection: Point2D; distance: number } | null {
    let best: { edgeIdx: number; projection: Point2D; distance: number } | null =
        null;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const proj = projectOnSegment(point, a, b);
        const d = Math.hypot(point[0] - proj[0], point[1] - proj[1]);
        if (d <= maxDistPx && (best === null || d < best.distance)) {
            best = { edgeIdx: i, projection: proj, distance: d };
        }
    }
    return best;
}

/**
 * Whether the polygon self-intersects (any pair of non-adjacent edges
 * crosses). Used as a soft warning — not a save blocker.
 */
export function hasSelfIntersection(poly: LarvaePolygon): boolean {
    const n = poly.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
        const a1 = poly[i];
        const a2 = poly[(i + 1) % n];
        for (let j = i + 1; j < n; j++) {
            // Skip adjacent edges (they share a vertex).
            if (j === i) continue;
            if ((j + 1) % n === i) continue;
            if (j === (i + 1) % n) continue;
            const b1 = poly[j];
            const b2 = poly[(j + 1) % n];
            if (segmentsIntersect(a1, a2, b1, b2)) return true;
        }
    }
    return false;
}

function cross(o: Point2D, a: Point2D, b: Point2D): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsIntersect(
    p1: Point2D,
    p2: Point2D,
    p3: Point2D,
    p4: Point2D,
): boolean {
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    if (
        ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    ) {
        return true;
    }
    return false;
}

/** Squared distance between two points (avoids the sqrt). */
export function sqDist(a: Point2D, b: Point2D): number {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return dx * dx + dy * dy;
}

/** Compute the axis-aligned bounding box of a polygon as [x1, y1, x2, y2]. */
export function polygonBBox(
    poly: LarvaePolygon,
): [number, number, number, number] {
    if (poly.length === 0) return [0, 0, 0, 0];
    let xMin = poly[0][0];
    let yMin = poly[0][1];
    let xMax = xMin;
    let yMax = yMin;
    for (let i = 1; i < poly.length; i++) {
        const [x, y] = poly[i];
        if (x < xMin) xMin = x;
        if (y < yMin) yMin = y;
        if (x > xMax) xMax = x;
        if (y > yMax) yMax = y;
    }
    return [xMin, yMin, xMax, yMax];
}

/** Shoelace area (always non-negative). */
export function polygonArea(poly: LarvaePolygon): number {
    const n = poly.length;
    if (n < 3) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % n];
        s += x1 * y2 - x2 * y1;
    }
    return Math.abs(s) / 2;
}
