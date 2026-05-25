import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { usePolygonEdits } from '@/features/results/larvae/usePolygonEdits';
import type { StoredLarvaeAnnotation } from '@/types/api';

function det(id: string, polygon: [number, number][]): StoredLarvaeAnnotation {
    return {
        detection_id: id,
        label: 'larvae',
        polygon,
        bbox: [0, 0, 10, 10],
        confidence: 0.9,
        area_px: 100,
        origin: 'model',
    };
}

describe('usePolygonEdits', () => {
    const detections: StoredLarvaeAnnotation[] = [
        det('a', [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
        ]),
    ];

    it('initialises from detections', () => {
        const { result } = renderHook(() => usePolygonEdits({ detections }));
        expect(result.current.polygons).toHaveLength(1);
        expect(result.current.isDirty).toBe(false);
        expect(result.current.canUndo).toBe(false);
    });

    it('moves a vertex and records history', () => {
        const { result } = renderHook(() => usePolygonEdits({ detections }));
        act(() => {
            result.current.moveVertex('a', 1, [15, 0]);
        });
        expect(result.current.polygons[0].polygon[1]).toEqual([15, 0]);
        expect(result.current.isDirty).toBe(true);
        expect(result.current.canUndo).toBe(true);
    });

    it('undoes and redoes', () => {
        const { result } = renderHook(() => usePolygonEdits({ detections }));
        act(() => {
            result.current.moveVertex('a', 1, [15, 0]);
        });
        act(() => {
            result.current.undo();
        });
        expect(result.current.polygons[0].polygon[1]).toEqual([10, 0]);
        expect(result.current.canRedo).toBe(true);
        act(() => {
            result.current.redo();
        });
        expect(result.current.polygons[0].polygon[1]).toEqual([15, 0]);
    });

    it('caps history at 20 ops', () => {
        const { result } = renderHook(() => usePolygonEdits({ detections }));
        for (let i = 0; i < 25; i++) {
            act(() => {
                result.current.moveVertex('a', 1, [10 + i, 0]);
            });
        }
        // After 25 commits we should be able to undo at most 20 of them.
        let undos = 0;
        for (let i = 0; i < 30; i++) {
            const before = result.current.polygons[0].polygon[1][0];
            act(() => {
                result.current.undo();
            });
            const after = result.current.polygons[0].polygon[1][0];
            if (before !== after) undos += 1;
            else break;
        }
        expect(undos).toBeLessThanOrEqual(20);
        expect(undos).toBeGreaterThan(0);
    });

    it('inserts and deletes vertices', () => {
        const { result } = renderHook(() => usePolygonEdits({ detections }));
        act(() => {
            result.current.insertVertex('a', 0, [5, 0]);
        });
        expect(result.current.polygons[0].polygon).toHaveLength(5);

        act(() => {
            result.current.deleteVertex('a', 1);
        });
        expect(result.current.polygons[0].polygon).toHaveLength(4);
    });

    it('rejects deletion that would drop below 3 vertices', () => {
        const triangle = [
            det('t', [
                [0, 0],
                [10, 0],
                [5, 10],
            ]),
        ];
        const { result } = renderHook(() => usePolygonEdits({ detections: triangle }));
        act(() => {
            result.current.deleteVertex('t', 0);
        });
        expect(result.current.polygons[0].polygon).toHaveLength(3);
        expect(result.current.canUndo).toBe(false);
    });

    it('addPolygon assigns a new client id and selects user origin', () => {
        const { result } = renderHook(() => usePolygonEdits({ detections }));
        let newId = '';
        act(() => {
            newId = result.current.addPolygon([
                [50, 50],
                [60, 50],
                [55, 60],
            ]);
        });
        expect(newId).toMatch(/^new:/);
        expect(result.current.polygons).toHaveLength(2);
        const added = result.current.polygons[1];
        expect(added.origin).toBe('user');
        expect(added.confidence).toBe(1.0);
    });

    it('resetToBaseline restores the original polygons', () => {
        const { result } = renderHook(() => usePolygonEdits({ detections }));
        act(() => {
            result.current.moveVertex('a', 0, [-5, -5]);
            result.current.addPolygon([
                [50, 50],
                [60, 50],
                [55, 60],
            ]);
        });
        act(() => {
            result.current.resetToBaseline();
        });
        expect(result.current.polygons).toHaveLength(1);
        expect(result.current.polygons[0].polygon[0]).toEqual([0, 0]);
        expect(result.current.isDirty).toBe(false);
    });

    it('previewSimplify does not push history', () => {
        const noisy = [
            det('n', [
                [0, 0],
                [5, 0.05],
                [10, 0],
                [10, 10],
                [0, 10],
            ]),
        ];
        const { result } = renderHook(() => usePolygonEdits({ detections: noisy }));
        let preview: ReturnType<typeof result.current.previewSimplify> = null;
        act(() => {
            preview = result.current.previewSimplify('n', 0.5);
        });
        expect(preview).not.toBeNull();
        expect(preview!.length).toBeLessThan(5);
        expect(result.current.canUndo).toBe(false);
    });
});
