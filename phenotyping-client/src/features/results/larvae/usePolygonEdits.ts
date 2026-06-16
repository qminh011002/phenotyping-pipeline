// usePolygonEdits — undo/redo + edit state for a single image's polygon set.
//
// The hook owns the in-session "working" polygon set (one per detection plus
// any user-drawn polygons) and exposes commit-style helpers (moveVertex,
// insertVertex, deleteVertex, deletePolygon, addPolygon, simplifySelected,
// resetToBaseline). Each commit pushes a snapshot onto the undo stack
// (capped at MAX_HISTORY).

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import type {
    LarvaePolygon,
    Point2D,
    StoredLarvaeAnnotation,
} from '@/types/api';

import {
    deleteVertex as opDeleteVertex,
    insertVertex as opInsertVertex,
    isValidPolygon,
    moveVertex as opMoveVertex,
    polygonArea,
    polygonBBox,
    simplifyPolygon,
    translatePolygon as opTranslatePolygon,
} from './polygonOps';

const MAX_HISTORY = 20;

/** A working polygon — either an existing detection or a freshly drawn one. */
export interface WorkingPolygon {
    /**
     * detection_id for existing detections; for user-drawn polygons we mint a
     * client-side id like `new:<n>` until the backend persists.
     */
    detection_id: string;
    polygon: LarvaePolygon;
    origin: 'model' | 'user';
    confidence: number;
    label: 'larvae';
    /** Original baseline polygon — what reset-to-model restores to. */
    baseline: LarvaePolygon | null;
}

interface HistoryState {
    past: WorkingPolygon[][];
    present: WorkingPolygon[];
    future: WorkingPolygon[][];
}

type HistoryAction =
    | { type: 'apply'; next: WorkingPolygon[] }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'reset'; next: WorkingPolygon[] }
    | {
          type: 'remap';
          mapper: (snapshot: WorkingPolygon[]) => WorkingPolygon[];
      };

function reducer(state: HistoryState, action: HistoryAction): HistoryState {
    switch (action.type) {
        case 'apply': {
            const past = [...state.past, state.present].slice(-MAX_HISTORY);
            return { past, present: action.next, future: [] };
        }
        case 'undo': {
            if (state.past.length === 0) return state;
            const previous = state.past[state.past.length - 1];
            return {
                past: state.past.slice(0, -1),
                present: previous,
                future: [state.present, ...state.future],
            };
        }
        case 'redo': {
            if (state.future.length === 0) return state;
            const next = state.future[0];
            return {
                past: [...state.past, state.present],
                present: next,
                future: state.future.slice(1),
            };
        }
        case 'reset':
            return { past: [], present: action.next, future: [] };
        case 'remap': {
            // Rewrite past/present/future snapshots without clearing history.
            // Used post-save to swap client-side `new:N` ids for the server's
            // freshly-minted UUIDs, so undo/redo still works after autosave.
            return {
                past: state.past.map(action.mapper),
                present: action.mapper(state.present),
                future: state.future.map(action.mapper),
            };
        }
        default:
            return state;
    }
}

/**
 * Fingerprint of a polygon's vertex sequence, used to map a client-side
 * `new:N` working polygon to its persisted UUID after save. Coordinates are
 * rounded so float drawing input matches the int polygon the backend echoes
 * back (`buildPolygonEdits` rounds to ints before sending; the backend calls
 * `int(...)` on each coord, so the stored shape is the same rounded set).
 */
function polyFingerprint(poly: LarvaePolygon): string {
    let out = '';
    for (let i = 0; i < poly.length; i++) {
        if (i > 0) out += '|';
        out += Math.round(poly[i][0]);
        out += ',';
        out += Math.round(poly[i][1]);
    }
    return out;
}

function fromDetections(detections: StoredLarvaeAnnotation[]): WorkingPolygon[] {
    return detections.map((d) => {
        const baseline = (d.polygon as LarvaePolygon) ?? null;
        const current = (d.edited_polygon ?? d.polygon) as LarvaePolygon;
        return {
            detection_id: d.detection_id,
            polygon: current,
            origin: d.origin,
            confidence: d.confidence,
            label: d.label,
            baseline,
        };
    });
}

function polysEqual(a: WorkingPolygon[], b: WorkingPolygon[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].detection_id !== b[i].detection_id) return false;
        const pa = a[i].polygon;
        const pb = b[i].polygon;
        if (pa === pb) continue;
        if (pa.length !== pb.length) return false;
        for (let j = 0; j < pa.length; j++) {
            if (pa[j][0] !== pb[j][0] || pa[j][1] !== pb[j][1]) return false;
        }
    }
    return true;
}

export interface UsePolygonEditsArgs {
    detections: StoredLarvaeAnnotation[];
    /**
     * Stable id of the image these detections belong to. History (undo/redo)
     * is only reset when this changes — so a post-save detection refresh
     * keeps the user's undo stack (matches the egg/neonate flow).
     */
    imageKey?: string | null;
    /** Image dimensions, for bounds checks (optional — clamping is best-effort). */
    width?: number | null;
    height?: number | null;
    /**
     * Called when client-side `new:N` ids are remapped to the server's UUIDs
     * after an autosave round-trip. The parent uses this to migrate any state
     * that references a working polygon by id (e.g. the current selection) so
     * it doesn't go stale and point at an id that no longer exists.
     */
    onIdsRemapped?: (mapping: Map<string, string>) => void;
}

export interface UsePolygonEditsApi {
    polygons: WorkingPolygon[];
    isDirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
    undo: () => void;
    redo: () => void;
    /** Replace all polygons with their model baselines (clears any user-drawn). */
    resetToBaseline: () => void;
    /** Replace polygons with a freshly-loaded server snapshot (e.g. after save). */
    syncFromDetections: (detections: StoredLarvaeAnnotation[]) => void;

    moveVertex: (detectionId: string, vertexIdx: number, next: Point2D) => void;
    /** Translate every vertex by (dx, dy). One commit per call. */
    translatePolygon: (detectionId: string, dx: number, dy: number) => void;
    insertVertex: (
        detectionId: string,
        edgeIdx: number,
        point: Point2D,
    ) => number;
    deleteVertex: (detectionId: string, vertexIdx: number) => boolean;
    deletePolygon: (detectionId: string) => void;
    /** Add a freshly-drawn polygon (origin=user). Returns its new id. */
    addPolygon: (polygon: LarvaePolygon) => string;
    simplifySelected: (detectionId: string, tolerance: number) => void;
    /**
     * Same as simplify but doesn't push history — for live preview while the
     * user drags the tolerance slider. Returns the simplified polygon.
     */
    previewSimplify: (
        detectionId: string,
        tolerance: number,
    ) => LarvaePolygon | null;
}

export function usePolygonEdits({
    detections,
    imageKey = null,
    onIdsRemapped,
}: UsePolygonEditsArgs): UsePolygonEditsApi {
    const baselineRef = useRef<WorkingPolygon[]>([]);
    const newIdSeqRef = useRef(0);
    const imageKeyRef = useRef<string | null>(imageKey);
    // Keep the latest remap callback in a ref so the resync effect (whose deps
    // are intentionally only [imageKey, detections]) can call it without going
    // stale or forcing the effect to re-run when the parent re-renders.
    const onIdsRemappedRef = useRef(onIdsRemapped);
    onIdsRemappedRef.current = onIdsRemapped;

    const [history, dispatch] = useReducer(reducer, undefined, () => {
        const initial = fromDetections(detections);
        baselineRef.current = initial;
        return { past: [], present: initial, future: [] };
    });

    // Mirror of the live working set so the resync effect can build the
    // new:N → UUID mapping from the polygons actually on screen.
    const presentRef = useRef(history.present);
    presentRef.current = history.present;

    // Resync when detections change. Cases:
    //   - imageKey changed (navigated to a different image) → full reset.
    //   - same imageKey, same id set (only polygon contents updated by save)
    //     → refresh baseline; leave history untouched (mirrors egg/neonate).
    //   - same imageKey, server added IDs (autosave persisted user-drawn
    //     `new:N` as real UUIDs) → remap past/present/future snapshots so
    //     each `new:N` becomes its server UUID (matched by polygon
    //     fingerprint), keeping the undo stack intact.
    //   - any other structural mismatch (server-side deletes we don't
    //     account for, fingerprint match failure) → fall back to full reset.
    const detectionsRef = useRef(detections);
    useEffect(() => {
        const imageChanged = imageKeyRef.current !== imageKey;
        if (!imageChanged && detectionsRef.current === detections) return;
        detectionsRef.current = detections;
        const next = fromDetections(detections);
        if (imageChanged) {
            imageKeyRef.current = imageKey;
            baselineRef.current = next;
            newIdSeqRef.current = 0;
            dispatch({ type: 'reset', next });
            return;
        }
        const oldBaselineIds = new Set(
            baselineRef.current.map((p) => p.detection_id),
        );
        const newIds = new Set(next.map((p) => p.detection_id));
        const sameIds =
            oldBaselineIds.size === newIds.size &&
            [...oldBaselineIds].every((id) => newIds.has(id));
        if (sameIds) {
            // Polygon contents may have shifted (server rounded our edits)
            // but the id set matches. Just refresh baseline.
            baselineRef.current = next;
            return;
        }
        // Structural change. Try a fingerprint-based remap of `new:N`
        // → UUID before resorting to a destructive reset.
        const removedFromBaseline = baselineRef.current.filter(
            (p) => !newIds.has(p.detection_id),
        );
        // Removed-baseline entries that we don't have a working-set entry
        // for are server-side deletes — we can't preserve history through
        // those, fall back to reset.
        const removedRealIds = removedFromBaseline.filter(
            (p) => !p.detection_id.startsWith('new:'),
        );
        // `next` is already WorkingPolygon[] (its `polygon` field is the
        // effective polygon — edited if present, otherwise the baseline).
        const fingerprintToNewId = new Map<string, string>();
        for (const wp of next) {
            if (oldBaselineIds.has(wp.detection_id)) continue;
            fingerprintToNewId.set(polyFingerprint(wp.polygon), wp.detection_id);
        }
        const newBaselineById = new Map(
            next.map((wp) => [wp.detection_id, wp] as const),
        );
        const mapper = (snapshot: WorkingPolygon[]): WorkingPolygon[] =>
            snapshot.map((wp) => {
                if (!wp.detection_id.startsWith('new:')) return wp;
                const uuid = fingerprintToNewId.get(polyFingerprint(wp.polygon));
                if (!uuid) return wp;
                const persisted = newBaselineById.get(uuid);
                // Adopt the persisted polygon's coords (rounded ints) so
                // polysEqual against the new baseline reports false-isDirty
                // — otherwise the user's float draw vertices would never
                // match the int-stored baseline and the "Unsaved" banner
                // would stay up forever after autosave.
                return {
                    ...wp,
                    detection_id: uuid,
                    polygon: persisted?.polygon ?? wp.polygon,
                    baseline: persisted?.baseline ?? wp.baseline,
                };
            });
        // Working polygons whose fingerprint doesn't match a newly-added
        // server detection keep their `new:N` id and get remapped on the
        // next save round-trip (or cleared by the next image-switch reset).
        // We only fall back to a destructive reset if the server removed
        // baseline detections that weren't in our working set — those we
        // can't reconcile.
        const remapPossible = removedRealIds.length === 0;
        baselineRef.current = next;
        if (remapPossible) {
            // Tell the parent which client-side ids just became server UUIDs so
            // it can migrate id-based state (selection) before it goes stale.
            const idMapping = new Map<string, string>();
            for (const wp of presentRef.current) {
                if (!wp.detection_id.startsWith('new:')) continue;
                const uuid = fingerprintToNewId.get(polyFingerprint(wp.polygon));
                if (uuid) idMapping.set(wp.detection_id, uuid);
            }
            dispatch({ type: 'remap', mapper });
            if (idMapping.size > 0) onIdsRemappedRef.current?.(idMapping);
            return;
        }
        // Last resort.
        newIdSeqRef.current = 0;
        dispatch({ type: 'reset', next });
    }, [imageKey, detections]);

    const apply = useCallback((next: WorkingPolygon[]) => {
        dispatch({ type: 'apply', next });
    }, []);

    const undo = useCallback(() => dispatch({ type: 'undo' }), []);
    const redo = useCallback(() => dispatch({ type: 'redo' }), []);

    const resetToBaseline = useCallback(() => {
        dispatch({ type: 'reset', next: baselineRef.current });
        newIdSeqRef.current = 0;
    }, []);

    const syncFromDetections = useCallback(
        (next: StoredLarvaeAnnotation[]) => {
            const wp = fromDetections(next);
            baselineRef.current = wp;
            newIdSeqRef.current = 0;
            dispatch({ type: 'reset', next: wp });
        },
        [],
    );

    const update = useCallback(
        (
            detectionId: string,
            mutate: (poly: LarvaePolygon) => LarvaePolygon | null,
        ): boolean => {
            const idx = history.present.findIndex(
                (p) => p.detection_id === detectionId,
            );
            if (idx < 0) return false;
            const target = history.present[idx];
            const nextPoly = mutate(target.polygon);
            if (!nextPoly || !isValidPolygon(nextPoly)) return false;
            if (nextPoly === target.polygon) return false;
            const next = history.present.slice();
            next[idx] = { ...target, polygon: nextPoly };
            apply(next);
            return true;
        },
        [history.present, apply],
    );

    const moveVertex = useCallback(
        (detectionId: string, vertexIdx: number, point: Point2D) => {
            update(detectionId, (poly) => opMoveVertex(poly, vertexIdx, point));
        },
        [update],
    );

    const translatePolygon = useCallback(
        (detectionId: string, dx: number, dy: number) => {
            if (dx === 0 && dy === 0) return;
            update(detectionId, (poly) => opTranslatePolygon(poly, dx, dy));
        },
        [update],
    );

    const insertVertex = useCallback(
        (detectionId: string, edgeIdx: number, point: Point2D): number => {
            let insertedAt = -1;
            update(detectionId, (poly) => {
                const result = opInsertVertex(poly, edgeIdx, point);
                insertedAt = result.insertedAt;
                return result.polygon;
            });
            return insertedAt;
        },
        [update],
    );

    const deleteVertex = useCallback(
        (detectionId: string, vertexIdx: number): boolean => {
            return update(detectionId, (poly) => {
                const next = opDeleteVertex(poly, vertexIdx);
                return next === poly ? null : next;
            });
        },
        [update],
    );

    const deletePolygon = useCallback(
        (detectionId: string) => {
            const next = history.present.filter(
                (p) => p.detection_id !== detectionId,
            );
            if (next.length === history.present.length) return;
            apply(next);
        },
        [history.present, apply],
    );

    const addPolygon = useCallback(
        (polygon: LarvaePolygon): string => {
            if (!isValidPolygon(polygon)) return '';
            const id = `new:${++newIdSeqRef.current}`;
            const wp: WorkingPolygon = {
                detection_id: id,
                polygon,
                origin: 'user',
                confidence: 1.0,
                label: 'larvae',
                baseline: null,
            };
            apply([...history.present, wp]);
            return id;
        },
        [history.present, apply],
    );

    const simplifySelected = useCallback(
        (detectionId: string, tolerance: number) => {
            update(detectionId, (poly) => simplifyPolygon(poly, tolerance));
        },
        [update],
    );

    const previewSimplify = useCallback(
        (detectionId: string, tolerance: number): LarvaePolygon | null => {
            const target = history.present.find(
                (p) => p.detection_id === detectionId,
            );
            if (!target) return null;
            return simplifyPolygon(target.polygon, tolerance);
        },
        [history.present],
    );

    const isDirty = useMemo(
        () => !polysEqual(history.present, baselineRef.current),
        [history.present],
    );

    return {
        polygons: history.present,
        isDirty,
        canUndo: history.past.length > 0,
        canRedo: history.future.length > 0,
        undo,
        redo,
        resetToBaseline,
        syncFromDetections,
        moveVertex,
        translatePolygon,
        insertVertex,
        deleteVertex,
        deletePolygon,
        addPolygon,
        simplifySelected,
        previewSimplify,
    };
}

/** Helper: rebuild a StoredLarvaeAnnotation-shaped object from a WorkingPolygon. */
export function workingPolygonToStored(
    wp: WorkingPolygon,
): StoredLarvaeAnnotation {
    const bbox = polygonBBox(wp.polygon);
    return {
        detection_id: wp.detection_id,
        label: wp.label,
        polygon: wp.baseline ?? wp.polygon,
        edited_polygon: wp.polygon,
        bbox,
        confidence: wp.confidence,
        area_px: polygonArea(wp.polygon),
        origin: wp.origin,
    };
}
