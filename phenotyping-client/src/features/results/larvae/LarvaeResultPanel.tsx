// LarvaeResultPanel — larvae batch viewer + polygon/calibration editor.
//
// Rendered by ResultViewer when the batch's organism_type is polygon-based
// (larvae/pupae). Composes:
//   - LarvaePolygonEditor (image + polygons + calibration corner handles)
//   - AnnotationToolbar (capability-driven; the same toolbar egg/neonate uses)
//   - LarvaeSummaryPanel + LarvaeMeasurementTable + LarvaeCalibrationBanner
//
// Polygon editing (FE-033) and calibration editing (FE-034) share the same
// save-then-remeasure flow.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Inbox, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/common/Spinner';
import { EmptyState } from '@/components/common/EmptyState';
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
import { cn } from '@/lib/utils';

import {
    detectCalibration,
    finishBatch,
    getAnalysesRawUrl,
    getLarvaeBatch,
    measureLarvae,
    saveCalibration,
    savePolygonEdits,
} from '@/services/api';

import type {
    CalibrationCorners,
    LarvaeBatchDetail,
    LarvaeImageDetail,
    LarvaePolygon,
    Organism,
    Point2D,
    PolygonEdit,
    StoredLarvaeAnnotation,
} from '@/types/api';

import { AnnotationToolbar, type AnnotationToolId } from '../components/AnnotationToolbar';
import { ResultViewerHeader } from '../components/ResultViewerHeader';
import { LarvaePolygonEditor, type LarvaePolygonTool } from './LarvaePolygonEditor';
import { LarvaeInferenceInfoPanel } from './LarvaeInferenceInfoPanel';
import { LarvaeMeasurementTable } from './LarvaeMeasurementTable';
import { LarvaeSummaryPanel } from './LarvaeSummaryPanel';
import { LarvaeCalibrationBanner } from './LarvaeCalibrationBanner';
import { CalibrationCornerEditorChrome } from './CalibrationCornerEditor';
import { CalibrationManualForm } from './CalibrationManualForm';
import type { Corners } from './calibrationMath';
import {
    usePolygonEdits,
    workingPolygonToStored,
    type WorkingPolygon,
} from './usePolygonEdits';

const SMOOTH_MIN = 0;
const SMOOTH_MAX = 5;
const SMOOTH_DEFAULT = 1;

/** Default calibration object size in mm (from LarvaeConfig defaults). */
const DEFAULT_CAL_W_MM = 405;
const DEFAULT_CAL_H_MM = 317;

interface LarvaeResultPanelProps {
    organism: Organism;
    className?: string;
}

type CalibrationMode = 'idle' | 'corners' | 'manual';

export function LarvaeResultPanel({ organism, className }: LarvaeResultPanelProps) {
    const navigate = useNavigate();
    const { batchId, imageId } = useParams<{ batchId: string; imageId?: string }>();

    const [batch, setBatch] = useState<LarvaeBatchDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [selectedDetectionId, setSelectedDetectionId] = useState<string | null>(null);
    const [activeTool, setActiveTool] = useState<AnnotationToolId | null>('select');
    const [smoothTolerance, setSmoothTolerance] = useState(SMOOTH_DEFAULT);
    const [smoothPreview, setSmoothPreview] = useState<WorkingPolygon['polygon'] | null>(
        null,
    );
    const [resetDialogOpen, setResetDialogOpen] = useState(false);
    const [dirtyNavDialogOpen, setDirtyNavDialogOpen] = useState(false);
    const [pendingNavIdx, setPendingNavIdx] = useState<number | null>(null);
    const [savingPolygons, setSavingPolygons] = useState(false);
    const [polygonInteractionInProgress, setPolygonInteractionInProgress] =
        useState(false);
    const [recalculatingMeasurements, setRecalculatingMeasurements] = useState(false);
    const [finishing, setFinishing] = useState(false);

    // ── Calibration editor state (FE-034) ───────────────────────────────────
    const [calMode, setCalMode] = useState<CalibrationMode>('idle');
    const [calCorners, setCalCorners] = useState<Corners | null>(null);
    const [savingCal, setSavingCal] = useState(false);
    const [redetecting, setRedetecting] = useState(false);
    // Bumped after the backend re-renders ``_warped.png`` / ``_overlay.png``
    // so the editor's blob fetch bypasses cached responses.
    const [imageCacheKey, setImageCacheKey] = useState(0);

    useEffect(() => {
        if (!batchId) {
            navigate('/', { replace: true });
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        setLoading(true);
        getLarvaeBatch(batchId, controller.signal)
            .then((detail) => {
                if (cancelled) return;
                setBatch(detail);
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

    const buildUrl = useCallback(
        (b: string, i: string) => `/analyze/results/${b}/images/${i}`,
        [],
    );

    const currentIndex = useMemo(() => {
        if (!batch || !imageId) return 0;
        const i = batch.images.findIndex((img) => img.image_id === imageId);
        return i >= 0 ? i : 0;
    }, [batch, imageId]);

    useEffect(() => {
        if (!batch || batch.images.length === 0) return;
        const valid = imageId && batch.images.some((img) => img.image_id === imageId);
        if (!valid) {
            navigate(buildUrl(batch.batch_id, batch.images[0].image_id), {
                replace: true,
            });
        }
    }, [batch, imageId, navigate, buildUrl]);

    useEffect(() => {
        setSelectedDetectionId(null);
        setSmoothPreview(null);
        setCalMode('idle');
        setCalCorners(null);
    }, [imageId]);

    const currentImage: LarvaeImageDetail | null = batch?.images[currentIndex] ?? null;

    const detections = useMemo(() => currentImage?.detections ?? [], [currentImage]);
    const edits = usePolygonEdits({
        detections,
        imageKey: currentImage?.image_id ?? null,
    });
    const {
        polygons: workingPolygons,
        isDirty,
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
        resetToBaseline,
    } = edits;

    const polygonTool: LarvaePolygonTool = activeTool === 'addPolygon' ? 'draw' : 'select';
    const hasPersistablePolygonEdits = useMemo(
        () => hasChangedPersistablePolygons(workingPolygons, detections),
        [workingPolygons, detections],
    );
    const currentMeasurementsStale = useMemo(
        () => currentImage?.measurements.some((m) => m.is_stale) ?? false,
        [currentImage],
    );
    const measurementsNeedRefresh = isDirty || currentMeasurementsStale;

    useEffect(() => {
        if (activeTool !== 'smooth') {
            setSmoothPreview(null);
            return;
        }
        if (!selectedDetectionId) return;
        const next = previewSimplify(selectedDetectionId, smoothTolerance);
        setSmoothPreview(next);
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
    const handleSave = useCallback(async () => {
        if (!batch || !currentImage || savingPolygons) return false;
        if (!isDirty) return true;

        let polygonEdits: PolygonEdit[];
        let deletedDetectionIds: string[];
        let userDrawnCount: number;
        try {
            ({ polygonEdits, deletedDetectionIds, userDrawnCount } = buildPolygonEdits(
                workingPolygons,
                detections,
            ));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Invalid polygon edit');
            return false;
        }

        if (polygonEdits.length === 0 && deletedDetectionIds.length === 0) return true;

        setSavingPolygons(true);
        try {
            await savePolygonEdits(batch.batch_id, currentImage.image_id, {
                polygons: polygonEdits,
                deleted_detection_ids: deletedDetectionIds,
            });
            if (userDrawnCount > 0 || deletedDetectionIds.length > 0) {
                const refreshed = await getLarvaeBatch(batch.batch_id);
                setBatch(refreshed);
            } else {
                setBatch((prev) =>
                    mergePolygonSaveUpdate(prev, currentImage.image_id, polygonEdits),
                );
            }
            return true;
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save polygons');
            return false;
        } finally {
            setSavingPolygons(false);
        }
    }, [batch, currentImage, isDirty, workingPolygons, detections, savingPolygons]);

    // Autosave persisted polygon edits only after an edit gesture ends. Measurement
    // is intentionally manual: dragging vertices should not block on
    // length/weight recalculation.
    const handleSaveRef = useRef(handleSave);
    useEffect(() => {
        handleSaveRef.current = handleSave;
    }, [handleSave]);
    useEffect(() => {
        if (
            !hasPersistablePolygonEdits ||
            savingPolygons ||
            polygonInteractionInProgress
        ) {
            return;
        }
        const timer = setTimeout(() => {
            void handleSaveRef.current();
        }, 400);
        return () => clearTimeout(timer);
    }, [hasPersistablePolygonEdits, savingPolygons, polygonInteractionInProgress]);

    const runMeasurementRefresh = useCallback(async () => {
        if (!currentImage || recalculatingMeasurements) return false;
        if (!currentImage.calibration) {
            toast.error('Calibration is required before measurements can run.');
            return false;
        }
        setRecalculatingMeasurements(true);
        try {
            const result = await measureLarvae(currentImage.image_id);
            setBatch((prev) => mergeMeasurementUpdate(prev, currentImage.image_id, result));
            return true;
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : 'Failed to recalculate measurements',
            );
            return false;
        } finally {
            setRecalculatingMeasurements(false);
        }
    }, [currentImage, recalculatingMeasurements]);

    const handleRecalculateMeasurements = useCallback(async () => {
        if (savingPolygons || recalculatingMeasurements) return;
        if (isDirty) {
            const saved = await handleSave();
            if (!saved) return;
        }
        await runMeasurementRefresh();
    }, [
        handleSave,
        isDirty,
        recalculatingMeasurements,
        runMeasurementRefresh,
        savingPolygons,
    ]);

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

    const remeasureCurrent = useCallback(
        async (imageIdInner: string, calibrationFromSave: CalibrationCorners) => {
            const result = await measureLarvae(imageIdInner);
            setBatch((prev) => {
                if (!prev) return prev;
                const idx = prev.images.findIndex((i) => i.image_id === imageIdInner);
                if (idx < 0) return prev;
                const target = prev.images[idx];
                const nextImage: LarvaeImageDetail = {
                    ...target,
                    calibration: calibrationFromSave,
                    measurements: result.measurements,
                };
                const nextImages = prev.images.slice();
                nextImages[idx] = nextImage;
                return { ...prev, images: nextImages };
            });
        },
        [],
    );

    const handleSaveCornerCalibration = useCallback(
        async (corners: Corners) => {
            if (!currentImage || !batch) return;
            let sanitizedCorners: Corners;
            try {
                sanitizedCorners = sanitizeCorners(corners);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Invalid calibration corners');
                return;
            }
            setSavingCal(true);
            try {
                await saveCalibration(currentImage.image_id, { corners: sanitizedCorners });
                // Backend re-rendered the warped overlay + polygons in the
                // new frame; refetch so detections / urls reflect that.
                const refreshed = await getLarvaeBatch(batch.batch_id);
                setBatch(refreshed);
                setImageCacheKey((k) => k + 1);
                // Recompute measurements for the current image now that
                // polygons live in a new warped space.
                await measureLarvae(currentImage.image_id);
                const refreshedAgain = await getLarvaeBatch(batch.batch_id);
                setBatch(refreshedAgain);
                toast.success('Calibration saved · measurements refreshed');
                exitCalibration();
            } catch (err) {
                toast.error(
                    err instanceof Error ? err.message : 'Failed to save calibration',
                );
            } finally {
                setSavingCal(false);
            }
        },
        [currentImage, batch, exitCalibration],
    );

    const handleSaveManualCalibration = useCallback(
        async (mmX: number, mmY: number) => {
            if (!currentImage) return;
            setSavingCal(true);
            try {
                const updated = await saveCalibration(currentImage.image_id, {
                    mm_per_px_x: mmX,
                    mm_per_px_y: mmY,
                });
                await remeasureCurrent(currentImage.image_id, updated);
                toast.success('Calibration saved · measurements refreshed');
                exitCalibration();
            } catch (err) {
                toast.error(
                    err instanceof Error ? err.message : 'Failed to save calibration',
                );
            } finally {
                setSavingCal(false);
            }
        },
        [currentImage, remeasureCurrent, exitCalibration],
    );

    const handleRedetect = useCallback(async () => {
        if (!currentImage) return;
        setRedetecting(true);
        try {
            const updated = await detectCalibration(currentImage.image_id);
            await remeasureCurrent(currentImage.image_id, updated);
            if (updated.detection_status === 'detected') {
                toast.success('Calibration re-detected');
            } else {
                toast.warning('Auto-detection still failed — try editing corners or manual.');
            }
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : 'Failed to re-detect calibration',
            );
        } finally {
            setRedetecting(false);
        }
    }, [currentImage, remeasureCurrent]);

    // ── Reset confirmation ─────────────────────────────────────────────────
    const handleResetConfirmed = useCallback(() => {
        resetToBaseline();
        setSelectedDetectionId(null);
        setResetDialogOpen(false);
        toast.success('Reset to model output');
    }, [resetToBaseline]);

    // ── Dirty nav guard ────────────────────────────────────────────────────
    const navigateToIndex = useCallback(
        (idx: number) => {
            if (!batch) return;
            const target = batch.images[idx];
            if (!target) return;
            navigate(buildUrl(batch.batch_id, target.image_id));
        },
        [batch, navigate, buildUrl],
    );

    const requestNavigate = useCallback(
        (idx: number) => {
            if (!isDirty) {
                navigateToIndex(idx);
                return;
            }
            setPendingNavIdx(idx);
            setDirtyNavDialogOpen(true);
        },
        [isDirty, navigateToIndex],
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

    useEffect(() => {
        if (!isDirty) return;
        function onBeforeUnload(e: BeforeUnloadEvent) {
            e.preventDefault();
            e.returnValue = '';
        }
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [isDirty]);

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
                    if (isDirty) setResetDialogOpen(true);
                    else toast.info('No edits to reset');
                    return;
                case 'editCalibration':
                    enterCornerMode();
                    return;
                case 'select':
                    if (calMode !== 'idle') exitCalibration();
                    setActiveTool('select');
                    setSelectedDetectionId(null);
                    return;
                case 'addPolygon':
                case 'smooth':
                    if (calMode !== 'idle') exitCalibration();
                    setActiveTool(id);
                    return;
                default:
                    return;
            }
        },
        [undo, redo, isDirty, handleSave, enterCornerMode, calMode, exitCalibration],
    );

    const handleEditorToolChange = useCallback((next: LarvaePolygonTool) => {
        setActiveTool(next === 'draw' ? 'addPolygon' : 'select');
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            const inputFocused =
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement;
            if (inputFocused) return;
            const isMac =
                (navigator as Navigator & { userAgentData?: { platform?: string } })
                    .userAgentData?.platform?.toUpperCase().includes('MAC') ??
                navigator.platform.toUpperCase().includes('MAC');
            const mod = isMac ? e.metaKey : e.ctrlKey;

            if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                redo();
                return;
            }
            if (mod && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                undo();
                return;
            }
            if (mod && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                if (isDirty && !savingPolygons) void handleSave();
                return;
            }
            if (e.key === 'd' || e.key === 'D') {
                e.preventDefault();
                setActiveTool((cur) =>
                    cur === 'addPolygon' ? 'select' : 'addPolygon',
                );
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
                if (activeTool === 'addPolygon' || activeTool === 'smooth') {
                    setActiveTool('select');
                } else {
                    setSelectedDetectionId(null);
                }
                return;
            }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [
        undo,
        redo,
        isDirty,
        deletePolygon,
        selectedDetectionId,
        activeTool,
        savingPolygons,
        handleSave,
        calMode,
        exitCalibration,
    ]);

    const tableDetections = useMemo(() => currentImage?.detections ?? [], [currentImage]);
    const workingDetectionsForSummary = useMemo(
        () => workingPolygons.map(workingPolygonToStored),
        [workingPolygons],
    );

    if (loading) {
        return (
            <div className="grid h-screen place-items-center">
                <Spinner />
            </div>
        );
    }

    if (!batch || !currentImage) {
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
    const rawFallback = getAnalysesRawUrl(batch.batch_id, currentImage.image_id);
    const baseEditorSrc =
        calMode === 'corners'
            ? rawFallback
            : (currentImage.warped_url ?? currentImage.raw_url ?? rawFallback);
    const editorSrc =
        imageCacheKey > 0
            ? `${baseEditorSrc}${baseEditorSrc.includes('?') ? '&' : '?'}v=${imageCacheKey}`
            : baseEditorSrc;
    const total = batch.images.length;
    const realWmm =
        currentImage.calibration?.calibration_object_w_mm ?? DEFAULT_CAL_W_MM;
    const realHmm =
        currentImage.calibration?.calibration_object_h_mm ?? DEFAULT_CAL_H_MM;

    const isSaved = batch.status === 'completed';
    const handleFinish = async () => {
        if (!batch || finishing) return;
        setFinishing(true);
        try {
            const shouldRefreshMeasurements = isDirty || currentMeasurementsStale;
            if (isDirty) {
                const ok = await handleSave();
                if (!ok) {
                    setFinishing(false);
                    return;
                }
            }
            if (shouldRefreshMeasurements) {
                const ok = await runMeasurementRefresh();
                if (!ok) {
                    setFinishing(false);
                    return;
                }
            }
            if (!isSaved) {
                const updated = await finishBatch(batch.batch_id);
                setBatch((prev) => (prev ? { ...prev, status: updated.status } : prev));
            }
            toast.success('Saved to Records');
            navigate(`/recorded?batch=${batch.batch_id}`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save to Records');
        } finally {
            setFinishing(false);
        }
    };

    const forceDisabled: Partial<Record<AnnotationToolId, boolean>> = {
        undo: !canUndo,
        redo: !canRedo,
        reset: !isDirty,
        smooth: !selectedDetectionId,
    };
    const canRecalculateMeasurements =
        Boolean(currentImage.calibration) &&
        currentImage.detections.length > 0 &&
        !savingPolygons &&
        !recalculatingMeasurements;
    const polygonSavePending =
        hasPersistablePolygonEdits &&
        !savingPolygons &&
        !polygonInteractionInProgress;
    const measurementStatusText = recalculatingMeasurements
        ? 'Recalculating measurements'
        : savingPolygons || polygonSavePending
          ? 'Saving polygon edits'
          : measurementsNeedRefresh
            ? 'Measurements need recalculation'
            : 'Measurements current';

    return (
        <div className={cn('flex h-screen flex-col', className)}>
            <ResultViewerHeader
                batchName={batch.name}
                batchStatus={batch.status}
                filename={currentImage.original_filename}
                currentIndex={currentIndex}
                total={total}
                isDirty={isDirty}
                isSaved={isSaved}
                finishing={finishing}
                onBack={() => navigate('/recorded')}
                onNavigate={requestNavigate}
                onFinish={handleFinish}
            />

            <div className="flex flex-1 overflow-hidden">
                <div className="relative flex-1 overflow-hidden border-r">
                    <LarvaePolygonEditor
                        rawSrc={editorSrc}
                        polygons={calMode === 'corners' ? [] : workingPolygons}
                        selectedDetectionId={selectedDetectionId}
                        onSelect={calMode === 'idle' ? setSelectedDetectionId : () => {}}
                        tool={polygonTool}
                        onToolChange={handleEditorToolChange}
                        onInteractionChange={setPolygonInteractionInProgress}
                        onMoveVertex={moveVertex}
                        onTranslatePolygon={translatePolygon}
                        onInsertVertex={insertVertex}
                        onDeleteVertex={deleteVertex}
                        onAddPolygon={addPolygon}
                        onDeletePolygon={deletePolygon}
                        measurements={currentImage.measurements}
                        saveInProgress={savingPolygons}
                        savePending={polygonSavePending}
                        previewPolygon={smoothPreview}
                        calibrationCorners={calMode === 'corners' ? calCorners : null}
                        onCalibrationCornersChange={setCalCorners}
                    />
                    <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 flex flex-col items-center gap-2">
                        <div
                            className={cn(
                                'transition-opacity duration-200 ease-out',
                                // Hide the toolbar entirely while drawing —
                                // press Esc (or the active button) to exit.
                                activeTool === 'addPolygon'
                                    ? 'pointer-events-none opacity-0'
                                    : 'pointer-events-auto opacity-100',
                            )}
                        >
                            <AnnotationToolbar
                                organism={organism}
                                activeTool={activeTool}
                                forceDisabled={forceDisabled}
                                onSelectTool={handleSelectTool}
                            />
                        </div>
                        {activeTool === 'smooth' && selectedDetectionId && (
                            <div className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-card p-3 shadow-sm">
                                <span className="text-xs font-medium text-muted-foreground">
                                    Smooth tolerance
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
                                <span className="tabular-nums text-xs">
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
                                    initialX={currentImage.calibration?.mm_per_px_x ?? null}
                                    initialY={currentImage.calibration?.mm_per_px_y ?? null}
                                    saving={savingCal}
                                    onSave={handleSaveManualCalibration}
                                    onCancel={exitCalibration}
                                />
                            </div>
                        )}
                        {isDirty && (
                            <div className="pointer-events-none rounded bg-amber-100 px-2 py-1 text-xs text-amber-900 shadow-sm dark:bg-amber-950/60 dark:text-amber-200">
                                Unsaved polygon edits — click Save or press
                                {' '}
                                {navigator.platform.toUpperCase().includes('MAC')
                                    ? '⌘S'
                                    : 'Ctrl+S'}
                            </div>
                        )}
                    </div>
                </div>
                <aside className="flex w-96 shrink-0 flex-col overflow-hidden bg-card">
                    {currentImage.calibration?.detection_status !== 'detected' && (
                        <div className="space-y-3 border-b p-4">
                            <LarvaeCalibrationBanner
                                calibration={currentImage.calibration}
                                onEditCorners={enterCornerMode}
                                onEditManual={enterManualMode}
                                onRedetect={handleRedetect}
                                redetecting={redetecting}
                            />
                        </div>
                    )}
                    <LarvaeSummaryPanel
                        batchId={batch.batch_id}
                        batchName={batch.name}
                        detections={workingDetectionsForSummary}
                        measurements={currentImage.measurements}
                        calibration={currentImage.calibration}
                    />
                    <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4 pt-0">
                        <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
                            <div className="min-w-0">
                                <p
                                    className={cn(
                                        'truncate text-sm font-medium',
                                        measurementsNeedRefresh
                                            ? 'text-amber-700 dark:text-amber-300'
                                            : 'text-foreground',
                                    )}
                                >
                                    {measurementStatusText}
                                </p>
                            </div>
                            <Button
                                size="sm"
                                variant={measurementsNeedRefresh ? 'default' : 'outline'}
                                onClick={handleRecalculateMeasurements}
                                disabled={!canRecalculateMeasurements}
                                title={
                                    currentImage.calibration
                                        ? 'Recalculate length, width, area, and weight'
                                        : 'Calibration is required before measurement'
                                }
                            >
                                <RefreshCw
                                    className={cn(
                                        'size-4',
                                        recalculatingMeasurements && 'animate-spin',
                                    )}
                                />
                                Recalculate
                            </Button>
                        </div>
                        <div className="flex-1 overflow-hidden">
                            <LarvaeMeasurementTable
                                detections={tableDetections}
                                measurements={currentImage.measurements}
                                selectedDetectionId={selectedDetectionId}
                                onSelect={setSelectedDetectionId}
                            />
                        </div>
                        <LarvaeInferenceInfoPanel
                            detectionModel={batch.detection_model}
                            samModel={batch.sam_model}
                            elapsedSecs={currentImage.elapsed_secs}
                        />
                    </div>
                </aside>
            </div>

            <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Reset to model output?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will discard your polygon edits and restore the original
                            model output. The change is undoable until you save.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep edits</AlertDialogCancel>
                        <AlertDialogAction onClick={handleResetConfirmed}>
                            Reset
                        </AlertDialogAction>
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
                            You have polygon edits that haven't been saved. If you navigate
                            away, those changes will be lost.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={cancelDirtyNav}>
                            Keep editing
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={confirmDiscardNav}>
                            Discard edits
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

// ── helpers ────────────────────────────────────────────────────────────────

function mergePolygonSaveUpdate(
    prev: LarvaeBatchDetail | null,
    imageId: string,
    polygonEdits: PolygonEdit[],
): LarvaeBatchDetail | null {
    if (!prev) return prev;
    const idx = prev.images.findIndex((i) => i.image_id === imageId);
    if (idx < 0) return prev;
    const target = prev.images[idx];
    const editedById = new Map(polygonEdits.map((e) => [e.detection_id, e.polygon]));
    const nowIso = new Date().toISOString();
    const nextDetections = target.detections.map((d) => {
        const editedPoly = editedById.get(d.detection_id);
        if (!editedPoly) return d;
        return { ...d, edited_polygon: editedPoly, edited_at: nowIso };
    });
    const editedIds = new Set(polygonEdits.map((e) => e.detection_id));
    const nextImage: LarvaeImageDetail = {
        ...target,
        detections: nextDetections,
        measurements: target.measurements.map((m) =>
            editedIds.has(m.detection_id) ? { ...m, is_stale: true } : m,
        ),
    };
    const nextImages = prev.images.slice();
    nextImages[idx] = nextImage;
    return { ...prev, images: nextImages };
}

function mergeMeasurementUpdate(
    prev: LarvaeBatchDetail | null,
    imageId: string,
    result: {
        calibration: CalibrationCorners | null;
        measurements: LarvaeImageDetail['measurements'];
    },
): LarvaeBatchDetail | null {
    if (!prev) return prev;
    const idx = prev.images.findIndex((i) => i.image_id === imageId);
    if (idx < 0) return prev;
    const nextImages = prev.images.slice();
    nextImages[idx] = {
        ...nextImages[idx],
        calibration: result.calibration,
        measurements: result.measurements,
    };
    return { ...prev, images: nextImages };
}

function buildPolygonEdits(
    workingPolygons: WorkingPolygon[],
    detections: StoredLarvaeAnnotation[],
): {
    polygonEdits: PolygonEdit[];
    deletedDetectionIds: string[];
    userDrawnCount: number;
} {
    const storedById = new Map(
        detections.map((d) => [d.detection_id, effectivePolygon(d)]),
    );
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

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
