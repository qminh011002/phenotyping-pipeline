// LarvaeResultPanel — larvae / pupae batch viewer, polygon + calibration
// editor, and the on-demand measuring step.
//
// Rendered by ResultViewer when the batch's organism_type is polygon-based.
// Composes:
//   - LarvaePolygonEditor (image + polygons + calibration corner handles)
//   - AnnotationToolbar (capability-driven; the same toolbar egg/neonate uses)
//   - the inspector: count, Measure card, measurement table, weight, details
//   - Filmstrip (every image of the batch with its count)
//
// Data: the batch opens on a summary payload (no polygons) and each image's
// polygons are fetched when it is first shown, so opening a 300-image batch
// costs the same as a 3-image one. Saves and measurements refresh only the
// image they touched.
//
// Batches are processed count-only by default; length / width / area /
// weight are computed here when the user asks (see measureFlow.ts).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, ImagePlus, Inbox, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { SegmentedControl } from '@/components/common';
import { EmptyState } from '@/components/common/EmptyState';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { addImagesPath, batchPath, isBatchPagePath } from '@/features/recorded/lib/paths';
import { useBackTo } from '@/hooks/useBackTo';
import { invalidateAuthedImages } from '@/hooks/useAuthedImage';
import { readPersistentFlag, usePersistentFlag } from '@/hooks/usePersistentFlag';
import { queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';

import {
    detectCalibration,
    downloadLarvaeCsv,
    finishBatch,
    getAnalysesRawUrl,
    getLarvaeBatchSummary,
    getLarvaeImage,
    getPolygonConfig,
    measureLarvae,
    saveCalibration,
    savePolygonEdits,
} from '@/services/api';

import type {
    LarvaeBatchDetail,
    LarvaeImageDetail,
    LarvaeMeasurement,
    LarvaePolygon,
    Organism,
    Point2D,
    PolygonEdit,
    StoredLarvaeAnnotation,
} from '@/types/api';

import { AnnotationToolbar, type AnnotationToolId } from '../components/AnnotationToolbar';
import { Filmstrip, type FilmstripItem } from '../components/Filmstrip';
import { ResultViewerHeader } from '../components/ResultViewerHeader';
import { ShortcutsDialog } from '../components/ShortcutsDialog';
import { LarvaePolygonEditor, type LarvaePolygonTool } from './LarvaePolygonEditor';
import { LarvaeCalibrationDetails, LarvaeInferenceInfoPanel } from './LarvaeInferenceInfoPanel';
import { LarvaeMeasurementTable } from './LarvaeMeasurementTable';
import { LarvaeMeasureCard, type MeasureRun } from './LarvaeMeasureCard';
import { LarvaeSummaryPanel } from './LarvaeSummaryPanel';
import { LarvaeWeightPanel } from './LarvaeWeightPanel';
import { LarvaeCalibrationBanner } from './LarvaeCalibrationBanner';
import { CalibrationCornerEditorChrome } from './CalibrationCornerEditor';
import { CalibrationManualForm } from './CalibrationManualForm';
import type { Corners } from './calibrationMath';
import { MEASURE_STEP_LABEL, calibrationUsable, measureImage, needsMeasuring } from './measureFlow';
import { usePolygonEdits, type WorkingPolygon } from './usePolygonEdits';

const SMOOTH_MIN = 0;
const SMOOTH_MAX = 5;
const SMOOTH_DEFAULT = 1;

/** Default calibration object size in mm (from LarvaeConfig defaults). */
const DEFAULT_CAL_W_MM = 405;
const DEFAULT_CAL_H_MM = 317;

/** Debounce between the end of an edit gesture and the autosave request. */
const AUTOSAVE_DELAY_MS = 400;
/** Grace period before a flush saves — lets a just-finished save's id remap
 *  land first, so freshly persisted polygons are never sent twice. */
const FLUSH_SETTLE_MS = 60;
const FLUSH_TIMEOUT_MS = 15_000;

const REFINE_PREF_KEY = 'phenotyping.measure.refine';
const CENTERLINES_PREF_KEY = 'phenotyping.viewer.centerlines';
const FILMSTRIP_PREF_KEY = 'phenotyping.filmstrip.collapsed';

const NO_DETECTIONS: StoredLarvaeAnnotation[] = [];
const NO_MEASUREMENTS: LarvaeMeasurement[] = [];
const NO_POLYGONS: WorkingPolygon[] = [];

interface LarvaeResultPanelProps {
    organism: Organism;
    className?: string;
}

type CalibrationMode = 'idle' | 'corners' | 'manual';
type InspectorTab = 'table' | 'weight' | 'details';

const INSPECTOR_TABS: Array<{ value: InspectorTab; label: string }> = [
    { value: 'table', label: 'Measurements' },
    { value: 'weight', label: 'Weight' },
    { value: 'details', label: 'Details' },
];

export function LarvaeResultPanel({ organism, className }: LarvaeResultPanelProps) {
    const navigate = useNavigate();
    const backTo = useBackTo();
    const { batchId, imageId } = useParams<{ batchId: string; imageId?: string }>();

    // Batch + one light row per image (counts, calibration — no polygons).
    const [summary, setSummary] = useState<LarvaeBatchDetail | null>(null);
    // Full payload of every image opened so far, keyed by image id.
    const [details, setDetails] = useState<Record<string, LarvaeImageDetail>>({});
    const [loading, setLoading] = useState(true);
    const [imageLoadFailed, setImageLoadFailed] = useState<string | null>(null);

    const [selectedDetectionId, setSelectedDetectionId] = useState<string | null>(null);
    const [activeTool, setActiveTool] = useState<AnnotationToolId>('select');
    const [smoothTolerance, setSmoothTolerance] = useState(SMOOTH_DEFAULT);
    const [smoothPreview, setSmoothPreview] = useState<WorkingPolygon['polygon'] | null>(null);
    const [resetDialogOpen, setResetDialogOpen] = useState(false);
    const [dirtyNavDialogOpen, setDirtyNavDialogOpen] = useState(false);
    const [pendingNavIdx, setPendingNavIdx] = useState<number | null>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [savingPolygons, setSavingPolygons] = useState(false);
    const [polygonInteractionInProgress, setPolygonInteractionInProgress] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [downloadingCsv, setDownloadingCsv] = useState(false);
    const [inspectorTab, setInspectorTab] = useState<InspectorTab>('table');

    // ── Measuring (on demand) ───────────────────────────────────────────────
    const [run, setRun] = useState<MeasureRun | null>(null);
    const cancelRunRef = useRef(false);
    // The SAM choice: what the user last picked, else the server's setting.
    const [refineChoice, setRefineChoice] = useState<boolean | null>(() =>
        readPersistentFlag(REFINE_PREF_KEY),
    );
    const configQuery = useQuery({
        queryKey: ['inference-config', organism],
        queryFn: ({ signal }) => getPolygonConfig(organism as 'larvae' | 'pupae', signal),
        staleTime: 60_000,
        enabled: refineChoice === null,
    });
    const refine = refineChoice ?? configQuery.data?.sam?.enabled ?? false;
    const handleRefineChange = useCallback((next: boolean) => {
        setRefineChoice(next);
        try {
            window.localStorage.setItem(REFINE_PREF_KEY, next ? '1' : '0');
        } catch {
            // Preference just won't persist.
        }
    }, []);

    const [showCenterlines, setShowCenterlines] = usePersistentFlag(CENTERLINES_PREF_KEY, true);
    const [filmstripCollapsed, setFilmstripCollapsed] = usePersistentFlag(
        FILMSTRIP_PREF_KEY,
        false,
    );

    // ── Calibration editor state (FE-034) ───────────────────────────────────
    const [calMode, setCalMode] = useState<CalibrationMode>('idle');
    const [calCorners, setCalCorners] = useState<Corners | null>(null);
    const [savingCal, setSavingCal] = useState(false);
    const [redetecting, setRedetecting] = useState(false);
    // Ctrl/Cmd held → hide polygon overlay so the raw image is visible.
    // Mirrors ResultViewer's ctrlHeld behavior for egg/neonate. The eye
    // toggle in the zoom bar is the sticky version of the same thing.
    const [ctrlHeld, setCtrlHeld] = useState(false);
    const [overlayHidden, setOverlayHidden] = useState(false);
    // Bumped after the backend re-renders ``_warped.png`` so the editor's
    // blob fetch bypasses cached responses.
    const [imageCacheKey, setImageCacheKey] = useState(0);

    // ── Load the batch summary ──────────────────────────────────────────────
    useEffect(() => {
        if (!batchId) {
            navigate('/', { replace: true });
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        setLoading(true);
        setDetails({});
        getLarvaeBatchSummary(batchId, controller.signal)
            .then((detail) => {
                if (!cancelled) setSummary(detail);
            })
            .catch((err) => {
                if (cancelled) return;
                toast.error(err instanceof Error ? err.message : 'Could not load batch');
                navigate('/', { replace: true });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [batchId, navigate]);

    const buildUrl = useCallback((b: string, i: string) => `/analyze/results/${b}/images/${i}`, []);

    const refreshSummary = useCallback(async () => {
        if (!batchId) return;
        try {
            setSummary(await getLarvaeBatchSummary(batchId));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not refresh batch');
        }
    }, [batchId]);

    /** Store one image's fresh server state and mirror it into its summary row. */
    const applyImage = useCallback((detail: LarvaeImageDetail) => {
        setDetails((prev) => ({ ...prev, [detail.image_id]: detail }));
        setSummary((prev) => {
            if (!prev) return prev;
            const idx = prev.images.findIndex((row) => row.image_id === detail.image_id);
            if (idx < 0) return prev;
            const images = prev.images.slice();
            images[idx] = { ...detail, detections: NO_DETECTIONS, measurements: NO_MEASUREMENTS };
            return { ...prev, images };
        });
    }, []);

    const currentIndex = useMemo(() => {
        if (!summary || !imageId) return 0;
        const i = summary.images.findIndex((img) => img.image_id === imageId);
        return i >= 0 ? i : 0;
    }, [summary, imageId]);

    useEffect(() => {
        if (!summary || summary.images.length === 0) return;
        const valid = imageId && summary.images.some((img) => img.image_id === imageId);
        if (!valid) {
            navigate(buildUrl(summary.batch_id, summary.images[0].image_id), { replace: true });
        }
    }, [summary, imageId, navigate, buildUrl]);

    useEffect(() => {
        setSelectedDetectionId(null);
        setSmoothPreview(null);
        setCalMode('idle');
        setCalCorners(null);
        setActiveTool((cur) => (cur === 'erase' || cur === 'addPolygon' ? cur : 'select'));
    }, [imageId]);

    const currentRow = summary?.images[currentIndex] ?? null;
    const currentImageId = currentRow?.image_id ?? null;
    const currentImage: LarvaeImageDetail | null =
        (currentImageId && details[currentImageId]) || null;

    // ── Lazy-load the image on screen, then warm the next one ───────────────
    const detailsRef = useRef(details);
    useLayoutEffect(() => {
        detailsRef.current = details;
    }, [details]);

    const loadImage = useCallback(
        (targetId: string, signal?: AbortSignal) => {
            if (!batchId) return Promise.resolve();
            return getLarvaeImage(batchId, targetId, signal).then((detail) => {
                // Don't clobber state that a save/measure put there meanwhile.
                setDetails((prev) => (prev[targetId] ? prev : { ...prev, [targetId]: detail }));
            });
        },
        [batchId],
    );

    useEffect(() => {
        if (!summary || !currentImageId || detailsRef.current[currentImageId]) return;
        const controller = new AbortController();
        setImageLoadFailed(null);
        loadImage(currentImageId, controller.signal).catch((err) => {
            if (controller.signal.aborted) return;
            setImageLoadFailed(currentImageId);
            toast.error(err instanceof Error ? err.message : 'Could not load image');
        });
        return () => controller.abort();
    }, [summary, currentImageId, loadImage]);

    const nextImageId = summary?.images[currentIndex + 1]?.image_id ?? null;
    useEffect(() => {
        if (!currentImage || !nextImageId || detailsRef.current[nextImageId]) return;
        // Best effort — a failure here surfaces when the user navigates.
        const timer = setTimeout(() => void loadImage(nextImageId).catch(() => {}), 150);
        return () => clearTimeout(timer);
    }, [currentImage, nextImageId, loadImage]);

    const detections = currentImage?.detections ?? NO_DETECTIONS;
    // Migrate the current selection when a freshly-drawn polygon's client-side
    // `new:N` id is replaced by the server UUID after autosave — otherwise the
    // selection (and thus Delete / panel actions) would point at an id that no
    // longer exists in the working set.
    const handleIdsRemapped = useCallback((mapping: Map<string, string>) => {
        setSelectedDetectionId((cur) => (cur && mapping.get(cur)) || cur);
    }, []);
    const edits = usePolygonEdits({
        detections,
        imageKey: currentImage?.image_id ?? null,
        onIdsRemapped: handleIdsRemapped,
    });
    const {
        polygons: workingPolygons,
        canUndo,
        canRedo,
        undo,
        redo,
        moveVertex,
        translatePolygon,
        insertVertex,
        deleteVertex,
        deletePolygon,
        addPolygon,
        simplifySelected,
        previewSimplify,
        resetToModel,
        differsFromModel,
        syncFromDetections,
    } = edits;

    const polygonTool: LarvaePolygonTool =
        activeTool === 'addPolygon' ? 'draw' : activeTool === 'erase' ? 'erase' : 'select';
    // Edits the server does not have yet. Compared against the stored
    // detections, so it is true from the first changed vertex until the save
    // that carries it has been acknowledged.
    const dirty = useMemo(
        () => hasChangedPersistablePolygons(workingPolygons, detections),
        [workingPolygons, detections],
    );
    const measurements = currentImage?.measurements ?? NO_MEASUREMENTS;
    const measurementsStale = useMemo(
        () =>
            measurements.some((m) => m.is_stale) ||
            (measurements.length > 0 && measurements.length < detections.length),
        [measurements, detections],
    );
    const outOfDate = measurements.length > 0 && (dirty || measurementsStale);

    useEffect(() => {
        if (activeTool !== 'smooth') {
            setSmoothPreview(null);
            return;
        }
        if (!selectedDetectionId) return;
        setSmoothPreview(previewSimplify(selectedDetectionId, smoothTolerance));
    }, [activeTool, smoothTolerance, selectedDetectionId, previewSimplify]);

    const applySmooth = useCallback(() => {
        if (!selectedDetectionId) return;
        simplifySelected(selectedDetectionId, smoothTolerance);
        setSmoothPreview(null);
        setActiveTool('select');
    }, [simplifySelected, selectedDetectionId, smoothTolerance]);

    const cancelSmooth = useCallback(() => {
        setSmoothPreview(null);
        setActiveTool('select');
    }, []);

    // ── Save polygons; measurements are recalculated explicitly ─────────────
    const savePromiseRef = useRef<Promise<boolean> | null>(null);
    const handleSave = useCallback((): Promise<boolean> => {
        if (savePromiseRef.current) return savePromiseRef.current;
        if (!batchId || !currentImage) return Promise.resolve(true);

        let built: ReturnType<typeof buildPolygonEdits>;
        try {
            built = buildPolygonEdits(workingPolygons, detections);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Invalid polygon edit');
            return Promise.resolve(false);
        }
        const { polygonEdits, deletedDetectionIds, userDrawnCount } = built;
        if (polygonEdits.length === 0 && deletedDetectionIds.length === 0) {
            return Promise.resolve(true);
        }

        const targetId = currentImage.image_id;
        const promise = (async () => {
            setSavingPolygons(true);
            try {
                await savePolygonEdits(batchId, targetId, {
                    polygons: polygonEdits,
                    deleted_detection_ids: deletedDetectionIds,
                });
                // The stored overlay is re-rendered lazily; drop cached copies,
                // and mark cached batch views (Records, dashboard) stale.
                invalidateAuthedImages(`${targetId}/thumbnail?variant=overlay`);
                markBatchCachesStale(batchId);
                if (userDrawnCount > 0 || deletedDetectionIds.length > 0) {
                    // New rows got server ids / rows disappeared — take the
                    // image's fresh state (one image, not the whole batch).
                    applyImage(await getLarvaeImage(batchId, targetId));
                } else {
                    const prev = detailsRef.current[targetId];
                    if (prev) applyImage(mergePolygonSave(prev, polygonEdits));
                }
                return true;
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed to save polygons');
                return false;
            } finally {
                savePromiseRef.current = null;
                setSavingPolygons(false);
            }
        })();
        savePromiseRef.current = promise;
        return promise;
    }, [batchId, currentImage, workingPolygons, detections, applyImage]);

    const handleSaveRef = useRef(handleSave);
    useLayoutEffect(() => {
        handleSaveRef.current = handleSave;
    }, [handleSave]);

    // Autosave persisted polygon edits only after an edit gesture ends. Measurement
    // is intentionally manual: dragging vertices should not block on
    // length/weight recalculation.
    useEffect(() => {
        if (!dirty || savingPolygons || polygonInteractionInProgress) return;
        const timer = setTimeout(() => void handleSaveRef.current(), AUTOSAVE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [dirty, savingPolygons, polygonInteractionInProgress]);

    // ── Flush: "make sure the server has every edit, then tell me" ──────────
    // Navigation, Finish and Measure all wait on this instead of asking the
    // user to save. It is driven by committed state (not by awaiting the save
    // promise) so a second save can never start from a stale snapshot.
    const flushWaitersRef = useRef<Array<(ok: boolean) => void>>([]);
    const [flushTick, setFlushTick] = useState(0);
    const settleFlush = useCallback((ok: boolean) => {
        const waiters = flushWaitersRef.current;
        flushWaitersRef.current = [];
        for (const resolve of waiters) resolve(ok);
    }, []);
    const flushPendingEdits = useCallback((): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
                flushWaitersRef.current = flushWaitersRef.current.filter((w) => w !== done);
                resolve(false);
            }, FLUSH_TIMEOUT_MS);
            const done = (ok: boolean) => {
                clearTimeout(timeout);
                resolve(ok);
            };
            flushWaitersRef.current.push(done);
            setFlushTick((t) => t + 1);
        });
    }, []);
    useEffect(() => {
        if (flushWaitersRef.current.length === 0) return;
        if (savingPolygons || polygonInteractionInProgress) return;
        if (!dirty) {
            settleFlush(true);
            return;
        }
        const timer = setTimeout(() => {
            void handleSaveRef.current().then((ok) => {
                if (!ok) settleFlush(false);
            });
        }, FLUSH_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [flushTick, dirty, savingPolygons, polygonInteractionInProgress, settleFlush]);
    // Never leave a caller hanging if the panel unmounts mid-flush.
    useEffect(() => () => settleFlush(false), [settleFlush]);

    // ── Measuring ───────────────────────────────────────────────────────────
    const summaryRef = useRef(summary);
    const currentImageIdRef = useRef(currentImageId);
    const syncFromDetectionsRef = useRef(syncFromDetections);
    useLayoutEffect(() => {
        summaryRef.current = summary;
        currentImageIdRef.current = currentImageId;
        syncFromDetectionsRef.current = syncFromDetections;
    }, [summary, currentImageId, syncFromDetections]);

    /** Take a server-side change to an image (polygons may have been rewritten). */
    const adoptServerImage = useCallback(
        (detail: LarvaeImageDetail, polygonsChanged: boolean) => {
            applyImage(detail);
            if (!polygonsChanged) return;
            invalidateAuthedImages(`${detail.image_id}/thumbnail?variant=overlay`);
            if (detail.image_id === currentImageIdRef.current) {
                // The working set must follow, or autosave would write the old
                // outlines straight back over the refined ones.
                syncFromDetectionsRef.current(detail.detections);
                setImageCacheKey((k) => k + 1);
                setSelectedDetectionId(null);
            }
        },
        [applyImage],
    );

    const runMeasure = useCallback(
        async (scope: 'image' | 'batch', refineOverride?: boolean) => {
            const useRefine = refineOverride ?? refine;
            const batch = summaryRef.current;
            if (!batch || run) return;
            const startId = currentImageIdRef.current;
            let targets = batch.images.filter((row) =>
                scope === 'image' ? row.image_id === startId : needsMeasuring(row),
            );
            if (scope === 'batch' && targets.length === 0) {
                targets = batch.images.filter((row) => row.detection_count > 0);
            }
            if (targets.length === 0) return;

            cancelRunRef.current = false;
            let measured = 0;
            let needCalibration = 0;
            let processed = 0;
            try {
                for (const target of targets) {
                    if (cancelRunRef.current) break;
                    const targetId = target.image_id;
                    setRun({
                        scope,
                        step: 'measure',
                        done: processed,
                        total: targets.length,
                        filename: target.original_filename,
                        imageId: targetId,
                        cancelling: false,
                    });
                    if (targetId === currentImageIdRef.current) {
                        const saved = await flushPendingEdits();
                        if (!saved)
                            throw new Error('Could not save your edits — measuring stopped.');
                    }
                    // Freshest row: an earlier step or a save may have changed it.
                    const row =
                        summaryRef.current?.images.find((r) => r.image_id === targetId) ?? target;
                    const result = await measureImage(batch.batch_id, row, {
                        refine: useRefine,
                        onStep: (step) => setRun((prev) => (prev ? { ...prev, step } : prev)),
                    });
                    adoptServerImage(result.image, result.polygonsChanged);
                    processed += 1;
                    if (result.outcome === 'measured') measured += 1;
                    else if (result.outcome === 'needs_calibration') needCalibration += 1;
                }
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Measuring failed');
                setRun(null);
                void refreshSummary();
                return;
            }
            setRun(null);
            // Batch weight statistics depend on every measured image.
            void refreshSummary();
            markBatchCachesStale(batch.batch_id);

            if (scope === 'image') {
                if (measured === 1) toast.success('Measured');
                else if (needCalibration === 1) {
                    toast.warning('No calibration found — set the scale to measure this image.');
                    setInspectorTab('details');
                }
                return;
            }
            const stopped = cancelRunRef.current && processed < targets.length;
            const parts = [`Measured ${measured} of ${targets.length} images`];
            if (needCalibration > 0) {
                parts.push(
                    `${needCalibration} need${needCalibration === 1 ? 's' : ''} calibration`,
                );
            }
            if (stopped) parts.push('stopped');
            if (needCalibration > 0 || stopped) toast.warning(parts.join(' · '));
            else toast.success(parts.join(' · '));
        },
        [run, refine, flushPendingEdits, adoptServerImage, refreshSummary],
    );

    const cancelRun = useCallback(() => {
        cancelRunRef.current = true;
        setRun((prev) => (prev ? { ...prev, cancelling: true } : prev));
    }, []);

    // ── Calibration: enter / cancel / save ──────────────────────────────────
    const enterCornerMode = useCallback(() => {
        if (!currentImage) return;
        const cal = currentImage.calibration;
        const seed = (cal?.edited_corners ?? cal?.auto_corners ?? null) as Corners | null;
        if (!seed) {
            toast.error('No corners to edit yet — try Re-detect or use Manual scale.');
            return;
        }
        setCalCorners(seed.map((p) => [p[0], p[1]]) as Corners);
        setCalMode('corners');
        setActiveTool('editCalibration');
    }, [currentImage]);

    const enterManualMode = useCallback(() => {
        setCalMode('manual');
        setActiveTool('editCalibration');
    }, []);

    const exitCalibration = useCallback(() => {
        setCalMode('idle');
        setCalCorners(null);
        setActiveTool('select');
    }, []);

    /** After a calibration change: sizes follow the new scale. */
    const remeasureAfterCalibration = useCallback(
        async (targetId: string) => {
            if (!batchId) return;
            await measureLarvae(targetId);
            adoptServerImage(await getLarvaeImage(batchId, targetId), true);
            void refreshSummary();
        },
        [batchId, adoptServerImage, refreshSummary],
    );

    const handleSaveCornerCalibration = useCallback(
        async (corners: Corners) => {
            if (!currentImage) return;
            let sanitizedCorners: Corners;
            try {
                sanitizedCorners = sanitizeCorners(corners);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Invalid calibration corners');
                return;
            }
            setSavingCal(true);
            try {
                if (!(await flushPendingEdits())) return;
                // Backend re-renders the warped image and moves the polygons
                // into the new frame.
                await saveCalibration(currentImage.image_id, { corners: sanitizedCorners });
                await remeasureAfterCalibration(currentImage.image_id);
                toast.success('Calibration saved · measurements refreshed');
                exitCalibration();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed to save calibration');
            } finally {
                setSavingCal(false);
            }
        },
        [currentImage, flushPendingEdits, remeasureAfterCalibration, exitCalibration],
    );

    const handleSaveManualCalibration = useCallback(
        async (mmX: number, mmY: number) => {
            if (!currentImage) return;
            setSavingCal(true);
            try {
                if (!(await flushPendingEdits())) return;
                await saveCalibration(currentImage.image_id, {
                    mm_per_px_x: mmX,
                    mm_per_px_y: mmY,
                });
                await remeasureAfterCalibration(currentImage.image_id);
                toast.success('Calibration saved · measurements refreshed');
                exitCalibration();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed to save calibration');
            } finally {
                setSavingCal(false);
            }
        },
        [currentImage, flushPendingEdits, remeasureAfterCalibration, exitCalibration],
    );

    const handleRedetect = useCallback(async () => {
        if (!currentImage || !batchId) return;
        setRedetecting(true);
        try {
            if (!(await flushPendingEdits())) return;
            const updated = await detectCalibration(currentImage.image_id);
            if (calibrationUsable(updated)) {
                await remeasureAfterCalibration(currentImage.image_id);
                toast.success('Calibration detected · measurements refreshed');
            } else {
                adoptServerImage(await getLarvaeImage(batchId, currentImage.image_id), true);
                toast.warning('Auto-detection still failed — try editing corners or manual.');
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to re-detect calibration');
        } finally {
            setRedetecting(false);
        }
    }, [currentImage, batchId, flushPendingEdits, remeasureAfterCalibration, adoptServerImage]);

    // ── Reset confirmation ─────────────────────────────────────────────────
    const handleResetConfirmed = useCallback(() => {
        resetToModel();
        setSelectedDetectionId(null);
        setResetDialogOpen(false);
        toast.success('Reset to model output');
    }, [resetToModel]);

    // ── Navigation (edits are flushed first; the dialog is the fallback) ────
    const navigateToIndex = useCallback(
        (idx: number) => {
            const batch = summaryRef.current;
            const target = batch?.images[idx];
            if (!batch || !target) return;
            // Replace: stepping through images is not a trail the browser's
            // Back button should have to unwind one image at a time.
            navigate(buildUrl(batch.batch_id, target.image_id), { replace: true });
        },
        [navigate, buildUrl],
    );

    const requestNavigate = useCallback(
        (idx: number) => {
            if (!dirty && !savingPolygons) {
                navigateToIndex(idx);
                return;
            }
            void flushPendingEdits().then((ok) => {
                if (ok) {
                    navigateToIndex(idx);
                } else {
                    setPendingNavIdx(idx);
                    setDirtyNavDialogOpen(true);
                }
            });
        },
        [dirty, savingPolygons, flushPendingEdits, navigateToIndex],
    );

    const confirmDiscardNav = useCallback(() => {
        setDirtyNavDialogOpen(false);
        if (pendingNavIdx !== null) navigateToIndex(pendingNavIdx);
        setPendingNavIdx(null);
    }, [pendingNavIdx, navigateToIndex]);

    const cancelDirtyNav = useCallback(() => {
        setDirtyNavDialogOpen(false);
        setPendingNavIdx(null);
    }, []);

    /** Close the viewer and return to the batch page once edits are safe. */
    const leaveToBatch = useCallback(
        (id: string) => {
            const go = () => backTo(batchPath(id), (path) => isBatchPagePath(path, id));
            if (!dirty && !savingPolygons) {
                go();
                return;
            }
            void flushPendingEdits().then((ok) => {
                if (ok) go();
            });
        },
        [dirty, savingPolygons, flushPendingEdits, backTo],
    );

    /** Leave the viewer for `path` once edits are safe. */
    const leaveTo = useCallback(
        (path: string) => {
            if (!dirty && !savingPolygons) {
                navigate(path);
                return;
            }
            void flushPendingEdits().then((ok) => {
                if (ok) navigate(path);
            });
        },
        [dirty, savingPolygons, flushPendingEdits, navigate],
    );

    useEffect(() => {
        if (!dirty) return;
        function onBeforeUnload(e: BeforeUnloadEvent) {
            e.preventDefault();
            e.returnValue = '';
        }
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [dirty]);

    // ── Tool selection ─────────────────────────────────────────────────────
    const handleSelectTool = useCallback(
        (id: AnnotationToolId) => {
            switch (id) {
                case 'undo':
                    undo();
                    return;
                case 'redo':
                    redo();
                    return;
                case 'reset':
                    if (differsFromModel) setResetDialogOpen(true);
                    else toast.info('No edits to reset');
                    return;
                case 'editCalibration':
                    if (calMode === 'idle') enterCornerMode();
                    else exitCalibration();
                    return;
                case 'select':
                    if (calMode !== 'idle') exitCalibration();
                    setActiveTool('select');
                    setSelectedDetectionId(null);
                    return;
                case 'addPolygon':
                case 'erase':
                    if (calMode !== 'idle') exitCalibration();
                    setSelectedDetectionId(null);
                    setActiveTool((cur) => (cur === id ? 'select' : id));
                    return;
                case 'smooth':
                    if (calMode !== 'idle') exitCalibration();
                    setActiveTool((cur) => (cur === id ? 'select' : id));
                    return;
                default:
                    return;
            }
        },
        [undo, redo, differsFromModel, enterCornerMode, calMode, exitCalibration],
    );

    const handleEditorToolChange = useCallback((next: LarvaePolygonTool) => {
        setActiveTool(next === 'draw' ? 'addPolygon' : next === 'erase' ? 'erase' : 'select');
    }, []);

    // Ctrl/Cmd-hold → reveal raw image (hide polygon overlay). Mirrors the
    // same gesture in ResultViewer for egg/neonate.
    useEffect(() => {
        const update = (e: KeyboardEvent) => setCtrlHeld(e.ctrlKey || e.metaKey);
        const clear = () => setCtrlHeld(false);
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') setCtrlHeld(false);
        };
        window.addEventListener('keydown', update);
        window.addEventListener('keyup', update);
        window.addEventListener('blur', clear);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            window.removeEventListener('keydown', update);
            window.removeEventListener('keyup', update);
            window.removeEventListener('blur', clear);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            const target = e.target;
            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                (target instanceof HTMLElement && target.isContentEditable)
            ) {
                return;
            }
            const isMac =
                (
                    navigator as Navigator & { userAgentData?: { platform?: string } }
                ).userAgentData?.platform
                    ?.toUpperCase()
                    .includes('MAC') ?? navigator.platform.toUpperCase().includes('MAC');
            const mod = isMac ? e.metaKey : e.ctrlKey;
            const key = e.key.toLowerCase();

            if (mod && e.shiftKey && key === 'z') {
                e.preventDefault();
                redo();
                return;
            }
            if (mod && key === 'z') {
                e.preventDefault();
                undo();
                return;
            }
            if (mod && key === 's') {
                e.preventDefault();
                void handleSaveRef.current();
                return;
            }
            if (mod || e.altKey) return;

            if (e.key === '?') {
                e.preventDefault();
                setShortcutsOpen(true);
                return;
            }
            if (key === 'v') {
                e.preventDefault();
                handleSelectTool('select');
                return;
            }
            if (key === 'd') {
                e.preventDefault();
                handleSelectTool('addPolygon');
                return;
            }
            if (key === 'e') {
                e.preventDefault();
                handleSelectTool('erase');
                return;
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedDetectionId) {
                    e.preventDefault();
                    deletePolygon(selectedDetectionId);
                    setSelectedDetectionId(null);
                }
                return;
            }
            if (e.key === 'Escape') {
                if (calMode !== 'idle') {
                    exitCalibration();
                    return;
                }
                if (activeTool !== 'select') setActiveTool('select');
                else setSelectedDetectionId(null);
            }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [
        undo,
        redo,
        deletePolygon,
        selectedDetectionId,
        activeTool,
        calMode,
        exitCalibration,
        handleSelectTool,
    ]);

    // ── Derived view data ───────────────────────────────────────────────────
    const userDrawnCount = useMemo(
        () => workingPolygons.reduce((n, p) => n + (p.origin === 'user' ? 1 : 0), 0),
        [workingPolygons],
    );
    const liveCount = currentImage ? workingPolygons.length : (currentRow?.detection_count ?? 0);

    const anyMeasured = useMemo(
        () => summary?.images.some((row) => row.measured_count + row.stale_count > 0) ?? false,
        [summary],
    );
    const filmstripItems = useMemo<FilmstripItem[]>(() => {
        if (!summary) return [];
        // A missing scale only matters once the batch is being measured.
        const scaleMatters = anyMeasured || !summary.count_only;
        return summary.images.map((row) => {
            const stale = row.stale_count > 0;
            const noScale = scaleMatters && !calibrationUsable(row.calibration);
            return {
                imageId: row.image_id,
                filename: row.original_filename,
                count:
                    row.image_id === currentImageId && currentImage
                        ? liveCount
                        : row.detection_count,
                flagged: stale || noScale,
                flagReason: stale
                    ? 'sizes are out of date'
                    : noScale
                      ? 'no calibration — cannot be measured yet'
                      : undefined,
            };
        });
    }, [summary, anyMeasured, currentImageId, currentImage, liveCount]);

    const pendingInBatch = useMemo(() => {
        if (!summary) return 0;
        return summary.images.reduce((n, row) => {
            if (row.image_id === currentImageId && currentImage) {
                // Live state of the image on screen (unsaved edits included).
                const needs =
                    workingPolygons.length > 0 && (measurements.length === 0 || outOfDate);
                return n + (needs ? 1 : 0);
            }
            return n + (needsMeasuring(row) ? 1 : 0);
        }, 0);
    }, [
        summary,
        currentImageId,
        currentImage,
        workingPolygons.length,
        measurements.length,
        outOfDate,
    ]);

    const handleDownloadCsv = useCallback(async () => {
        if (!summary) return;
        setDownloadingCsv(true);
        try {
            await flushPendingEdits();
            const { blob, filename } = await downloadLarvaeCsv(summary.batch_id, summary.name);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'CSV download failed');
        } finally {
            setDownloadingCsv(false);
        }
    }, [summary, flushPendingEdits]);

    const handleWeightSaved = useCallback(() => {
        if (!batchId || !currentImageId) return;
        void getLarvaeImage(batchId, currentImageId)
            .then((detail) => applyImage(detail))
            .catch(() => {});
        void refreshSummary();
    }, [batchId, currentImageId, applyImage, refreshSummary]);

    if (loading) {
        return (
            <div className="grid h-screen place-items-center">
                <Spinner />
            </div>
        );
    }

    if (!summary || !currentRow) {
        return (
            <div className="grid h-screen place-items-center">
                <EmptyState
                    icon={Inbox}
                    title="Batch unavailable"
                    description={`This ${organism} batch has no images to display.`}
                />
            </div>
        );
    }

    // Editor backing image: warped (no marks) by default so SVG cyan polygons
    // sit on a clean rectified canvas. In calibration-corner mode swap to the
    // raw original so the user marks the green rectangle on the un-warped frame.
    const rawFallback = getAnalysesRawUrl(summary.batch_id, currentRow.image_id);
    const baseEditorSrc =
        calMode === 'corners'
            ? rawFallback
            : (currentRow.warped_url ?? currentRow.raw_url ?? rawFallback);
    const editorSrc =
        imageCacheKey > 0
            ? `${baseEditorSrc}${baseEditorSrc.includes('?') ? '&' : '?'}v=${imageCacheKey}`
            : baseEditorSrc;
    const total = summary.images.length;
    const calibration = currentImage?.calibration ?? currentRow.calibration;
    const realWmm = calibration?.calibration_object_w_mm ?? DEFAULT_CAL_W_MM;
    const realHmm = calibration?.calibration_object_h_mm ?? DEFAULT_CAL_H_MM;
    const scaleOk = calibrationUsable(calibration);

    const isSaved = summary.status === 'completed';
    const handleFinish = async () => {
        if (finishing) return;
        setFinishing(true);
        try {
            if (!(await flushPendingEdits())) return;
            // An image that was measured keeps its sizes in step with its
            // outlines. Count-only images are saved as they are.
            const row = summaryRef.current?.images.find((r) => r.image_id === currentRow.image_id);
            if (row && row.stale_count > 0 && calibrationUsable(row.calibration)) {
                await measureLarvae(row.image_id);
                applyImage(await getLarvaeImage(summary.batch_id, row.image_id));
            }
            if (!isSaved) {
                const updated = await finishBatch(summary.batch_id);
                setSummary((prev) => (prev ? { ...prev, status: updated.status } : prev));
            }
            toast.success('Saved to Records');
            backTo(batchPath(summary.batch_id), (path) => isBatchPagePath(path, summary.batch_id));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save to Records');
        } finally {
            setFinishing(false);
        }
    };

    const forceDisabled: Partial<Record<AnnotationToolId, boolean>> = {
        undo: !canUndo,
        redo: !canRedo,
        reset: !differsFromModel,
        smooth: !selectedDetectionId,
    };
    const savePending = dirty && !savingPolygons && !polygonInteractionInProgress;
    // While a step is rewriting this image on the server, hold edits.
    const busyOnThisImage = (run !== null && run.imageId === currentRow.image_id) || savingCal;
    const controlsDisabled = run !== null || savingCal || redetecting || !currentImage;

    return (
        <div className={cn('flex h-screen flex-col bg-background', className)}>
            <ResultViewerHeader
                batchName={summary.name}
                batchStatus={summary.status}
                organism={organism}
                filename={currentRow.original_filename}
                currentIndex={currentIndex}
                total={total}
                isDirty={dirty || savingPolygons}
                isSaved={isSaved}
                finishing={finishing}
                onBack={() => leaveToBatch(summary.batch_id)}
                onNavigate={requestNavigate}
                onFinish={handleFinish}
                onShowShortcuts={() => setShortcutsOpen(true)}
                actions={
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => leaveTo(addImagesPath(summary.batch_id, organism))}
                        title="Add more images to this batch and analyse them"
                    >
                        <ImagePlus />
                        <span className="hidden xl:inline">Add images</span>
                    </Button>
                }
            />

            <div className="flex min-h-0 flex-1">
                <div className="relative flex min-w-0 flex-1 flex-col">
                    <div className="relative min-h-0 flex-1">
                        <LarvaePolygonEditor
                            rawSrc={editorSrc}
                            polygons={
                                calMode === 'corners' || !currentImage
                                    ? NO_POLYGONS
                                    : workingPolygons
                            }
                            selectedDetectionId={selectedDetectionId}
                            onSelect={calMode === 'idle' ? setSelectedDetectionId : noop}
                            tool={polygonTool}
                            onToolChange={handleEditorToolChange}
                            onInteractionChange={setPolygonInteractionInProgress}
                            onMoveVertex={moveVertex}
                            onTranslatePolygon={translatePolygon}
                            onInsertVertex={insertVertex}
                            onDeleteVertex={deleteVertex}
                            onAddPolygon={addPolygon}
                            onDeletePolygon={deletePolygon}
                            measurements={measurements}
                            showCenterlines={showCenterlines && !outOfDate}
                            saveInProgress={savingPolygons}
                            savePending={savePending}
                            previewPolygon={smoothPreview}
                            calibrationCorners={calMode === 'corners' ? calCorners : null}
                            onCalibrationCornersChange={setCalCorners}
                            // Hide the polygon overlay while Ctrl/Cmd is held, but
                            // keep it visible during calibration corner editing —
                            // the user needs the corner handles to remain on
                            // screen while they line them up.
                            overlayVisible={
                                calMode === 'corners' ? true : !ctrlHeld && !overlayHidden
                            }
                            onToggleOverlay={() => setOverlayHidden((v) => !v)}
                        />

                        {/* Tool rail */}
                        <div className="pointer-events-none absolute top-3 left-3 z-20">
                            <AnnotationToolbar
                                organism={organism}
                                orientation="vertical"
                                activeTool={activeTool}
                                forceDisabled={forceDisabled}
                                onSelectTool={handleSelectTool}
                                className="pointer-events-auto"
                            />
                        </div>

                        {/* Contextual panels for the smooth / calibration tools */}
                        <div className="pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
                            {activeTool === 'smooth' && selectedDetectionId && (
                                <div className="floating-panel pointer-events-auto flex items-center gap-3 p-2.5">
                                    <span className="text-xs font-medium text-muted-foreground">
                                        Smooth
                                    </span>
                                    <Slider
                                        value={[smoothTolerance]}
                                        min={SMOOTH_MIN}
                                        max={SMOOTH_MAX}
                                        step={0.1}
                                        onValueChange={(v) => setSmoothTolerance(v[0] ?? 0)}
                                        className="w-40"
                                        aria-label="Smooth tolerance"
                                    />
                                    <span className="w-10 font-mono text-xs tabular-nums">
                                        {smoothTolerance.toFixed(1)}px
                                    </span>
                                    <Button size="sm" variant="ghost" onClick={cancelSmooth}>
                                        Cancel
                                    </Button>
                                    <Button size="sm" onClick={applySmooth}>
                                        Apply
                                    </Button>
                                </div>
                            )}
                            {calMode === 'corners' && calCorners && (
                                <CalibrationCornerEditorChrome
                                    corners={calCorners}
                                    realWmm={realWmm}
                                    realHmm={realHmm}
                                    saving={savingCal}
                                    onSave={handleSaveCornerCalibration}
                                    onCancel={exitCalibration}
                                    onRedetect={handleRedetect}
                                    redetecting={redetecting}
                                />
                            )}
                            {calMode === 'manual' && (
                                <div className="pointer-events-auto w-80">
                                    <CalibrationManualForm
                                        initialX={calibration?.mm_per_px_x ?? null}
                                        initialY={calibration?.mm_per_px_y ?? null}
                                        saving={savingCal}
                                        onSave={handleSaveManualCalibration}
                                        onCancel={exitCalibration}
                                    />
                                </div>
                            )}
                        </div>

                        {!currentImage && (
                            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
                                {imageLoadFailed === currentRow.image_id ? (
                                    <div className="floating-panel pointer-events-auto flex items-center gap-3 px-3 py-2 text-sm">
                                        Could not load the detections for this image.
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                setImageLoadFailed(null);
                                                loadImage(currentRow.image_id).catch(() =>
                                                    setImageLoadFailed(currentRow.image_id),
                                                );
                                            }}
                                        >
                                            Retry
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="floating-panel flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                        Loading detections…
                                    </div>
                                )}
                            </div>
                        )}

                        {run !== null ? (
                            // A measuring run rewrites outlines and sizes on
                            // the server; the canvas stays locked until it ends.
                            <MeasuringOverlay run={run} />
                        ) : (
                            busyOnThisImage && (
                                // Calibration is being saved; edits made now
                                // would be overwritten.
                                <div className="absolute inset-0 z-30 cursor-progress bg-background/20" />
                            )
                        )}
                    </div>

                    <Filmstrip
                        batchId={summary.batch_id}
                        items={filmstripItems}
                        currentIndex={currentIndex}
                        onNavigate={requestNavigate}
                        collapsed={filmstripCollapsed}
                        onToggleCollapsed={() => setFilmstripCollapsed((v) => !v)}
                    />
                </div>

                <aside
                    className="flex w-[23rem] shrink-0 flex-col overflow-hidden border-l border-border bg-card"
                    data-result-aside
                >
                    <LarvaeSummaryPanel
                        organism={organism}
                        count={liveCount}
                        userDrawnCount={userDrawnCount}
                        calibration={calibration}
                        samRefined={currentRow.sam_refined}
                        loading={!currentImage && currentRow.detection_count === 0}
                    />
                    <LarvaeMeasureCard
                        organism={organism}
                        count={liveCount}
                        measurements={measurements}
                        outOfDate={outOfDate}
                        scaleOk={scaleOk}
                        scaleUntried={calibration === null}
                        samRefined={currentRow.sam_refined}
                        refine={refine}
                        onRefineChange={handleRefineChange}
                        pendingInBatch={pendingInBatch}
                        totalInBatch={total}
                        run={run}
                        onMeasureImage={(options) => void runMeasure('image', options?.refine)}
                        onMeasureBatch={() => void runMeasure('batch')}
                        onCancelRun={cancelRun}
                        showCenterlines={showCenterlines}
                        onShowCenterlinesChange={setShowCenterlines}
                        disabled={controlsDisabled}
                    />
                    {!scaleOk && currentImage && (
                        <div className="px-4 pb-3">
                            <LarvaeCalibrationBanner
                                calibration={calibration}
                                onEditCorners={enterCornerMode}
                                onEditManual={enterManualMode}
                                onRedetect={handleRedetect}
                                redetecting={redetecting}
                            />
                        </div>
                    )}

                    <div className="border-t border-border px-4 py-2">
                        <SegmentedControl
                            aria-label="Inspector section"
                            size="sm"
                            value={inspectorTab}
                            onChange={setInspectorTab}
                            options={INSPECTOR_TABS}
                            className="w-full [&>*]:flex-1"
                        />
                    </div>

                    <div className="min-h-0 flex-1 overflow-hidden border-t border-border">
                        {inspectorTab === 'table' && (
                            <LarvaeMeasurementTable
                                detections={detections}
                                measurements={measurements}
                                selectedDetectionId={selectedDetectionId}
                                onSelect={setSelectedDetectionId}
                            />
                        )}
                        {inspectorTab === 'weight' && (
                            <div className="h-full overflow-y-auto">
                                <LarvaeWeightPanel
                                    organism={organism}
                                    imageId={currentRow.image_id}
                                    totalWeightMg={
                                        currentImage?.total_weight_mg ?? currentRow.total_weight_mg
                                    }
                                    measured={measurements.length > 0}
                                    weightStats={summary.weight_stats ?? null}
                                    onWeightSaved={handleWeightSaved}
                                />
                            </div>
                        )}
                        {inspectorTab === 'details' && (
                            <div className="h-full space-y-5 overflow-y-auto p-4">
                                <LarvaeCalibrationDetails
                                    calibration={calibration}
                                    onEditCorners={enterCornerMode}
                                    onEditManual={enterManualMode}
                                    onRedetect={handleRedetect}
                                    redetecting={redetecting}
                                    disabled={controlsDisabled}
                                />
                                <LarvaeInferenceInfoPanel
                                    organism={organism}
                                    detectionModel={summary.detection_model}
                                    samModel={summary.sam_model}
                                    elapsedSecs={currentRow.elapsed_secs}
                                    countOnly={summary.count_only}
                                    samRefined={currentRow.sam_refined}
                                />
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
                        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                            {anyMeasured
                                ? `Counts and sizes for all ${total} image${total === 1 ? '' : 's'}`
                                : `Counts for all ${total} image${total === 1 ? '' : 's'} · sizes after measuring`}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0"
                            onClick={handleDownloadCsv}
                            disabled={downloadingCsv}
                        >
                            {downloadingCsv ? <Loader2 className="animate-spin" /> : <Download />}
                            CSV
                        </Button>
                    </div>
                </aside>
            </div>

            <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} polygon />

            <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Reset to model output?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Every outline goes back to what the model produced, and outlines you
                            drew by hand are removed. Detections you deleted are not restored. You
                            can undo this with Ctrl+Z.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep edits</AlertDialogCancel>
                        <AlertDialogAction onClick={handleResetConfirmed}>Reset</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog
                open={dirtyNavDialogOpen}
                onOpenChange={(o) => (o ? setDirtyNavDialogOpen(true) : cancelDirtyNav())}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Unsaved polygon edits</AlertDialogTitle>
                        <AlertDialogDescription>
                            Your latest polygon edits could not be saved. If you navigate away,
                            those changes will be lost.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={cancelDirtyNav}>Keep editing</AlertDialogCancel>
                        <AlertDialogAction onClick={confirmDiscardNav}>
                            Discard edits
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function noop() {}

/** Other screens cache this batch (Records detail, dashboard); after an edit
 *  or a measure run they refetch the next time they are shown. */
function markBatchCachesStale(batchId: string): void {
    void queryClient.invalidateQueries({
        queryKey: ['analysis-detail', batchId],
        refetchType: 'none',
    });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'], refetchType: 'none' });
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Local equivalent of what the server did for an edits-only save: the edited
 *  outlines are stored and their measurements are now stale. */
function mergePolygonSave(
    image: LarvaeImageDetail,
    polygonEdits: PolygonEdit[],
): LarvaeImageDetail {
    const editedById = new Map(polygonEdits.map((e) => [e.detection_id, e.polygon]));
    const nowIso = new Date().toISOString();
    const detections = image.detections.map((d) => {
        const editedPoly = editedById.get(d.detection_id);
        if (!editedPoly) return d;
        return { ...d, edited_polygon: editedPoly, edited_at: nowIso };
    });
    const measurements = image.measurements.map((m) =>
        editedById.has(m.detection_id) ? { ...m, is_stale: true } : m,
    );
    const stale = measurements.reduce((n, m) => n + (m.is_stale ? 1 : 0), 0);
    return {
        ...image,
        detections,
        measurements,
        stale_count: stale,
        measured_count: measurements.length - stale,
    };
}

function buildPolygonEdits(
    workingPolygons: WorkingPolygon[],
    detections: StoredLarvaeAnnotation[],
): {
    polygonEdits: PolygonEdit[];
    deletedDetectionIds: string[];
    userDrawnCount: number;
} {
    const storedById = new Map(detections.map((d) => [d.detection_id, effectivePolygon(d)]));
    const workingExistingIds = new Set(
        workingPolygons
            .filter((wp) => !wp.detection_id.startsWith('new:'))
            .map((wp) => wp.detection_id),
    );
    const deletedDetectionIds = detections
        .filter((d) => !workingExistingIds.has(d.detection_id))
        .map((d) => d.detection_id);
    const polygonEdits: PolygonEdit[] = [];
    let userDrawnCount = 0;

    for (const wp of workingPolygons) {
        const isUserDrawn = wp.detection_id.startsWith('new:');
        if (isUserDrawn) {
            userDrawnCount += 1;
        } else if (!UUID_RE.test(wp.detection_id)) {
            throw new Error('Invalid detection id; reload the image and try again.');
        }
        const stored = storedById.get(wp.detection_id);
        if (!stored && !isUserDrawn) continue;
        const polygon = sanitizePolygon(wp.polygon);
        if (stored && polygonsEqual(polygon, sanitizePolygon(stored))) continue;
        if (isUserDrawn && wp.origin === 'model') {
            // A model detection whose delete was saved and then undone: it
            // goes back as the model detection it was.
            polygonEdits.push({
                detection_id: wp.detection_id,
                polygon,
                origin: 'model',
                confidence: wp.confidence,
                baseline: wp.baseline ? sanitizePolygon(wp.baseline) : null,
            });
            continue;
        }
        polygonEdits.push({ detection_id: wp.detection_id, polygon });
    }

    return { polygonEdits, deletedDetectionIds, userDrawnCount };
}

function hasChangedPersistablePolygons(
    workingPolygons: WorkingPolygon[],
    detections: StoredLarvaeAnnotation[],
): boolean {
    try {
        const { polygonEdits, deletedDetectionIds } = buildPolygonEdits(
            workingPolygons,
            detections,
        );
        return polygonEdits.length > 0 || deletedDetectionIds.length > 0;
    } catch {
        return false;
    }
}

function effectivePolygon(detection: StoredLarvaeAnnotation): LarvaePolygon {
    return detection.edited_polygon ?? detection.polygon;
}

function sanitizePolygon(poly: LarvaePolygon): LarvaePolygon {
    if (!Array.isArray(poly) || poly.length < 3) {
        throw new Error('Polygon must have at least 3 points.');
    }
    const sanitized = poly.map((point) => sanitizePoint(point));
    if (polygonArea(sanitized) <= 0) {
        throw new Error('Polygon must enclose a non-zero area.');
    }
    return sanitized;
}

function sanitizePoint(point: Point2D): Point2D {
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('Polygon contains invalid coordinates.');
    }
    return [Math.max(0, Math.round(x)), Math.max(0, Math.round(y))];
}

function sanitizeCorners(corners: Corners): Corners {
    if (!Array.isArray(corners) || corners.length !== 4) {
        throw new Error('Calibration requires exactly 4 corners.');
    }
    return corners.map((point) => sanitizePoint(point)) as Corners;
}

function polygonsEqual(a: LarvaePolygon, b: LarvaePolygon): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
    }
    return true;
}

function polygonArea(poly: LarvaePolygon): number {
    let total = 0;
    for (let i = 0; i < poly.length; i += 1) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        total += x1 * y2 - x2 * y1;
    }
    return Math.abs(total) / 2;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Covers the canvas while a measuring run is in flight: says what is
 *  happening and swallows every pointer / wheel event underneath. */
function MeasuringOverlay({ run }: { run: MeasureRun }) {
    const batch = run.scope === 'batch';
    const pct = run.total > 0 ? (run.done / run.total) * 100 : 0;
    return (
        <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-30 flex cursor-progress items-center justify-center bg-background/40 backdrop-blur-[1px]"
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
        >
            <div className="floating-panel flex w-72 max-w-[calc(100%-2rem)] flex-col gap-3 px-5 py-4">
                <div className="flex items-center gap-3">
                    <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold">
                            {run.cancelling ? 'Stopping…' : 'Measuring…'}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                            {MEASURE_STEP_LABEL[run.step]}
                        </p>
                    </div>
                </div>
                {batch && (
                    <div className="flex flex-col gap-1.5">
                        <div
                            className="h-1.5 overflow-hidden rounded-full bg-muted"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={run.total}
                            aria-valuenow={run.done}
                        >
                            <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span className="truncate font-mono" title={run.filename}>
                                {run.filename}
                            </span>
                            <span className="shrink-0 tabular-nums">
                                {Math.min(run.done + 1, run.total)} of {run.total}
                            </span>
                        </p>
                    </div>
                )}
                <p className="text-xs text-muted-foreground">
                    The image is locked until measuring finishes.
                </p>
            </div>
        </div>
    );
}
