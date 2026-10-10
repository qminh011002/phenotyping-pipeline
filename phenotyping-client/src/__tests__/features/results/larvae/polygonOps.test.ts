import { describe, it, expect } from 'vitest';

import {
    deleteVertex,
    distanceToOutline,
    findClosestEdge,
    hasSelfIntersection,
    insertVertex,
    isValidPolygon,
    moveVertex,
    packBBoxes,
    pickPolygon,
    pointInPolygon,
    polygonArea,
    polygonBBox,
    projectOnSegment,
    simplifyPolygon,
} from '@/features/results/larvae/polygonOps';
import type { LarvaePolygon } from '@/types/api';

const SQUARE: LarvaePolygon = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
];

describe('polygonOps', () => {
    describe('moveVertex', () => {
        it('replaces a vertex', () => {
            const next = moveVertex(SQUARE, 1, [12, -1]);
            expect(next[1]).toEqual([12, -1]);
            expect(next[0]).toEqual(SQUARE[0]);
        });

        it('returns the original on out-of-range idx', () => {
            expect(moveVertex(SQUARE, 9, [1, 2])).toBe(SQUARE);
        });
    });

    describe('insertVertex', () => {
        it('inserts after the given edge index', () => {
            const { polygon, insertedAt } = insertVertex(SQUARE, 0, [5, 0]);
            expect(insertedAt).toBe(1);
            expect(polygon).toEqual([
                [0, 0],
                [5, 0],
                [10, 0],
                [10, 10],
                [0, 10],
            ]);
        });
    });

    describe('deleteVertex', () => {
        it('removes the vertex when polygon stays valid', () => {
            const next = deleteVertex(
                [
                    [0, 0],
                    [10, 0],
                    [10, 10],
                    [5, 12],
                    [0, 10],
                ],
                3,
            );
            expect(next).toHaveLength(4);
        });

        it('rejects when the polygon would drop below 3 vertices', () => {
            const triangle: LarvaePolygon = [
                [0, 0],
                [1, 0],
                [0, 1],
            ];
            expect(deleteVertex(triangle, 0)).toBe(triangle);
        });
    });

    describe('isValidPolygon', () => {
        it('requires ≥3 vertices', () => {
            expect(isValidPolygon(SQUARE)).toBe(true);
            expect(isValidPolygon([[0, 0], [1, 1]])).toBe(false);
        });
    });

    describe('simplifyPolygon', () => {
        it('drops near-collinear vertices', () => {
            const noisy: LarvaePolygon = [
                [0, 0],
                [5, 0.05],
                [10, 0],
                [10, 10],
                [0, 10],
            ];
            const simplified = simplifyPolygon(noisy, 0.5);
            expect(simplified.length).toBeLessThan(noisy.length);
            expect(simplified.length).toBeGreaterThanOrEqual(3);
        });

        it('returns original at zero tolerance', () => {
            expect(simplifyPolygon(SQUARE, 0)).toBe(SQUARE);
        });

        it('never returns fewer than 3 vertices', () => {
            const result = simplifyPolygon(SQUARE, 9999);
            expect(result.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('projectOnSegment', () => {
        it('clamps to segment endpoints', () => {
            expect(projectOnSegment([-10, 5], [0, 0], [10, 0])).toEqual([0, 0]);
            expect(projectOnSegment([20, -5], [0, 0], [10, 0])).toEqual([10, 0]);
        });

        it('projects mid-segment', () => {
            expect(projectOnSegment([5, 5], [0, 0], [10, 0])).toEqual([5, 0]);
        });
    });

    describe('findClosestEdge', () => {
        it('finds the nearest edge within tolerance', () => {
            const hit = findClosestEdge(SQUARE, [5, 0.5], 2);
            expect(hit).not.toBeNull();
            expect(hit!.edgeIdx).toBe(0);
            expect(hit!.projection[0]).toBeCloseTo(5);
        });

        it('returns null when no edge is close enough', () => {
            expect(findClosestEdge(SQUARE, [50, 50], 2)).toBeNull();
        });
    });

    describe('hasSelfIntersection', () => {
        it('detects a bowtie', () => {
            const bowtie: LarvaePolygon = [
                [0, 0],
                [10, 10],
                [10, 0],
                [0, 10],
            ];
            expect(hasSelfIntersection(bowtie)).toBe(true);
        });

        it('returns false for a simple square', () => {
            expect(hasSelfIntersection(SQUARE)).toBe(false);
        });
    });

    describe('polygonBBox', () => {
        it('computes axis-aligned bounds', () => {
            expect(polygonBBox(SQUARE)).toEqual([0, 0, 10, 10]);
        });
    });

    describe('polygonArea', () => {
        it('uses the shoelace formula', () => {
            expect(polygonArea(SQUARE)).toBe(100);
        });
    });

    describe('pointInPolygon', () => {
        it('tests the inside of a square', () => {
            expect(pointInPolygon(SQUARE, [5, 5])).toBe(true);
            expect(pointInPolygon(SQUARE, [11, 5])).toBe(false);
            expect(pointInPolygon(SQUARE, [5, -1])).toBe(false);
        });

        it('ignores vertex order', () => {
            expect(pointInPolygon([...SQUARE].reverse(), [5, 5])).toBe(true);
        });

        it('fills both lobes of a bowtie (nonzero, like SVG)', () => {
            const bowtie: LarvaePolygon = [
                [0, 0],
                [10, 10],
                [10, 0],
                [0, 10],
            ];
            // Lobes left and right of the crossing at (5, 5).
            expect(pointInPolygon(bowtie, [2, 5])).toBe(true);
            expect(pointInPolygon(bowtie, [8, 5])).toBe(true);
            expect(pointInPolygon(bowtie, [5, 1])).toBe(false);
        });

        it('fills a region wound twice once, not as a hole (nonzero, not even-odd)', () => {
            // Two laps around the same square: winding 2 inside.
            const twice: LarvaePolygon = [...SQUARE, ...SQUARE];
            expect(pointInPolygon(twice, [5, 5])).toBe(true);
        });
    });

    describe('distanceToOutline', () => {
        it('measures to the nearest edge, closing edge included', () => {
            expect(distanceToOutline(SQUARE, [5, 5])).toBe(5);
            expect(distanceToOutline(SQUARE, [-3, 5])).toBe(3);
            expect(distanceToOutline(SQUARE, [13, 14])).toBe(5);
        });
    });

    describe('pickPolygon', () => {
        const right: LarvaePolygon = SQUARE.map(([x, y]) => [x + 5, y]);
        const polygons = [SQUARE, right];
        const bboxes = packBBoxes(polygons);

        it('returns the topmost (last painted) polygon under the point', () => {
            expect(pickPolygon(polygons, bboxes, [7, 5], 0.5)).toBe(1);
            expect(pickPolygon(polygons, bboxes, [2, 5], 0.5)).toBe(0);
        });

        it('counts the stroke as part of the hit area', () => {
            expect(pickPolygon(polygons, bboxes, [15.4, 5], 0.5)).toBe(1);
            expect(pickPolygon(polygons, bboxes, [15.6, 5], 0.5)).toBe(-1);
        });

        it('returns -1 on empty space', () => {
            expect(pickPolygon(polygons, bboxes, [40, 40], 0.5)).toBe(-1);
        });
    });
});
