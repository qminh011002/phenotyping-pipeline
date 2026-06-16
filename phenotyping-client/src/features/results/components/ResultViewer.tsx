// ResultViewer — full page for viewing inference results.
// Renders the RAW uploaded image (from the browser blob URL stored in
// sessionStorage) with client-side bbox overlays drawn from
// result.annotations. The backend-generated overlay PNG is only used
// for the Download button — never displayed.
//
// Annotation Editor (FS-009):
// - "Edit" toggle in header activates the AnnotationEditor slot.
// - Edit mode: boxes are rendered by AnnotationEditor (not OverlayImage's SVG).
// - User-drawn boxes are NOT filtered by confidence threshold.
// - Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo.
// - D toggles draw mode; Escape cancels/deselects.
// - Save edits persists to DB; Reset-to-model clears with confirmation.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { toast } from 'sonner';

import type {
    AnalysisBatchDetail,
    AnalysisImageDetail,
    BBox,
    DetectionResult,
    Organism,
} from '@/types/api';
import {
    loadBatchDetail,
    loadProcessingFiles,
    loadProcessingConfig,
    loadProcessingResults,
    loadProjectClasses,
    storeBatchDetail,
} from '@/features/upload/lib/processingSession';
import { consumeStartIndex } from '@/features/recorded/lib/openBatchInResults';
import {
    completeBatch,
    finishBatch,
    getAnalysesRawUrl,
    getAnalysisDetail,
    getImageDetail,
    putEditedAnnotations,
    resetEditedAnnotations,
} from '@/services/api';
import { cn } from '@/lib/utils';

import { boxesEqual } from '../lib/bboxMath';
import { canRedo, canUndo, editorHistoryReducer } from '../lib/editorHistory';

import { ResultViewerContent } from './ResultViewerContent';
import { ResultViewerDialogs } from './ResultViewerDialogs';
import { ResultViewerHeader } from './ResultViewerHeader';
import { LarvaeResultPanel } from '../larvae/LarvaeResultPanel';

interface ResultViewerProps {
    className?: string;
}

type SaveEditsArgs = {
    imageId?: string;
    boxesToSave?: BBox[];
    force?: boolean;
};

export function ResultViewer({ className }: ResultViewerProps) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    // Path params: /analyze/results/:batchId/images/:imageId
    // Both segments are optional; the component canonicalizes missing
    // imageId by redirecting to the first image of the batch.
    const { batchId: batchIdFromUrl = null, imageId: imageIdFromUrl = null } = useParams<{
        batchId?: string;
        imageId?: string;
    }>();

    /** Build the canonical results URL for a given batch + image. */
    const buildUrl = useCallback(
        (batchId: string, imageId: string) => `/analyze/results/${batchId}/images/${imageId}`,
        [],
    );

    // Lite batch detail (image metadata only — annotations live in the cache)
    const [batchDetail, setBatchDetail] = useState<AnalysisBatchDetail | null>(null);

    // Per-image annotations cache. Keyed by image UUID. Lazy-fetched as the
    // user navigates so batch open is O(1) regardless of image count.
    const imageDetailCache = useRef<Map<string, AnalysisImageDetail>>(new Map());
    // Reactive bump so derived values re-compute when the cache fills async.
    const [cacheVersion, setCacheVersion] = useState(0);
    const bumpCache = useCallback(() => setCacheVersion((v) => v + 1), []);

    const [rawUrlByName, setRawUrlByName] = useState<Record<string, string>>({});
    const [processingConfig, setProcessingConfig] = useState<Record<string, unknown> | null>(null);
    const [loading, setLoading] = useState(true);
    const [confidenceThreshold, setConfidenceThreshold] = useState<number>(0);

    // ── Editor state (FS-009) ─────────────────────────────────────────────────
    const editMode = true;
    /**
     * Active tool within edit mode.
     * - "drag": the unified Drag tool — click a box to select it, drag its body
     *   to move, drag a corner/side handle to resize, drag empty area to pan,
     *   click empty area to deselect.
     * - "draw": rubber-band a new box; pan disabled.
     */
    const [editorTool, setEditorTool] = useState<'drag' | 'draw'>('drag');
    const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
    // Classes are defined on AnalyzePage and persisted both to the batch row
    // (authoritative) and sessionStorage (used during the live processing
    // round-trip before batchDetail is loaded). Prefer the batch row when
    // present so opening a saved batch from /recorded shows its own classes.
    const [sessionClasses] = useState<string[]>(() => loadProjectClasses());
    const projectClasses =
        batchDetail?.classes && batchDetail.classes.length > 0
            ? batchDetail.classes
            : sessionClasses;
    const defaultClass = projectClasses[0];
    const [history, dispatchHistory] = useReducer(editorHistoryReducer, {
        past: [],
        present: [],
        future: [],
    });
    const [savingEdits, setSavingEdits] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [resetDialogOpen, setResetDialogOpen] = useState(false);
    const [dirtyNavDialogOpen, setDirtyNavDialogOpen] = useState(false);
    const [quitDialogOpen, setQuitDialogOpen] = useState(false);
    /** Index the user wants to navigate to while dirty */
    const [pendingNavIdx, setPendingNavIdx] = useState<number | null>(null);
    /** Ctrl/Cmd held — in non-edit mode this temporarily hides the dim overlay. */
    const [ctrlHeld, setCtrlHeld] = useState(false);
    const previousImageIdRef = useRef<string | null>(null);

    // ── Mount: load batch detail (URL-driven, with sessionStorage fallback) ──
    useEffect(() => {
        let cancelled = false;

        async function load() {
            const storedConfig = loadProcessingConfig();
            const storedFiles = loadProcessingFiles();
            setProcessingConfig(storedConfig);
            setRawUrlByName(Object.fromEntries(storedFiles.map((f) => [f.name, f.blobUrl])));

            // Path 1: URL has ?batch=<id> → fetch lite detail from DB.
            // This is the canonical path: works on reload, share, new tab,
            // browser back/forward.
            if (batchIdFromUrl) {
                try {
                    const detail = await queryClient.fetchQuery({
                        queryKey: [
                            'analysis-detail',
                            batchIdFromUrl,
                            { includeAnnotations: false },
                        ],
                        queryFn: ({ signal }) =>
                            getAnalysisDetail(batchIdFromUrl, signal, {
                                includeAnnotations: false,
                            }),
                    });
                    if (cancelled) return;
                    setBatchDetail(detail);
                    // Hydrate cache from sessionStorage if the user came straight
                    // from /analyze/processing — annotations are already in RAM,
                    // no need to round-trip the network for them.
                    //
                    // edited_annotations comes from the *stored* batch detail
                    // (populated by openBatchInResults / processing flow).
                    // ``detail.images[i].edited_annotations`` from the network
                    // call is always null here because we requested
                    // includeAnnotations:false. If the stored detail is also
                    // missing, leave the cache entry alone so the lazy fetch
                    // can pull the authoritative value from the backend.
                    const stored = loadProcessingResults();
                    const storedDetail = loadBatchDetail();
                    const storedEditedByName = new Map<string, BBox[] | null | undefined>(
                        (storedDetail?.images ?? []).map((i) => [
                            i.original_filename,
                            i.edited_annotations,
                        ]),
                    );
                    for (const r of stored) {
                        const img = detail.images.find((i) => i.original_filename === r.filename);
                        if (img && !imageDetailCache.current.has(img.id)) {
                            const storedEdited = storedEditedByName.get(r.filename);
                            // ``undefined`` ⇒ no info from sessionStorage; skip caching
                            // so the lazy-fetch effect populates from the backend.
                            if (storedEdited === undefined) continue;
                            imageDetailCache.current.set(img.id, {
                                ...img,
                                annotations: r.result.annotations as unknown as null,
                                edited_annotations: storedEdited,
                            } as AnalysisImageDetail);
                        }
                    }
                    bumpCache();
                    setLoading(false);
                } catch {
                    if (cancelled) return;
                    toast.error('Could not load batch — redirecting home');
                    navigate('/', { replace: true });
                }
                return;
            }

            // Path 2: No URL params — fall back to sessionStorage and upgrade
            // to URL-driven by writing the params (replace, no history entry).
            const stored = loadProcessingResults();
            const storedDetail = loadBatchDetail();
            if (stored.length === 0 || !storedDetail) {
                navigate('/', { replace: true });
                return;
            }
            setBatchDetail(storedDetail as AnalysisBatchDetail);
            for (const r of stored) {
                const img = storedDetail.images.find((i) => i.original_filename === r.filename);
                if (img && !imageDetailCache.current.has(img.id)) {
                    imageDetailCache.current.set(img.id, {
                        ...img,
                        annotations: r.result.annotations as unknown as null,
                        edited_annotations: img.edited_annotations ?? null,
                    } as AnalysisImageDetail);
                }
            }
            bumpCache();
            const startIdx = consumeStartIndex();
            const idx =
                startIdx !== null && startIdx >= 0 && startIdx < storedDetail.images.length
                    ? startIdx
                    : 0;
            const targetId = storedDetail.images[idx]?.id;
            if (targetId) {
                navigate(buildUrl(storedDetail.id, targetId), { replace: true });
            }
            setLoading(false);
        }

        load();
        return () => {
            cancelled = true;
        };
    }, [batchIdFromUrl, buildUrl, bumpCache, navigate, queryClient]);

    // ── Current index derived from URL ──────────────────────────────────────
    const currentIndex = useMemo(() => {
        if (!batchDetail) return 0;
        if (imageIdFromUrl) {
            const i = batchDetail.images.findIndex((img) => img.id === imageIdFromUrl);
            return i >= 0 ? i : 0;
        }
        return 0;
    }, [batchDetail, imageIdFromUrl]);

    // If URL image ID is missing or doesn't match any image in the batch,
    // canonicalize to the first image. Avoids rendering a stale index, and
    // means /analyze/results/<batchId> alone is a valid public URL.
    useEffect(() => {
        if (!batchDetail) return;
        const valid =
            imageIdFromUrl !== null && batchDetail.images.some((img) => img.id === imageIdFromUrl);
        if (!valid && batchDetail.images.length > 0) {
            navigate(buildUrl(batchDetail.id, batchDetail.images[0].id), {
                replace: true,
            });
        }
    }, [batchDetail, imageIdFromUrl, navigate, buildUrl]);

    // ── Image record lookup (lite metadata from batchDetail.images) ─────────
    const currentImageRecord = useMemo(() => {
        if (!batchDetail) return null;
        return batchDetail.images[currentIndex] ?? null;
    }, [batchDetail, currentIndex]);

    // ── Lazy fetch annotations for the current image ────────────────────────
    useEffect(() => {
        if (!batchDetail || !currentImageRecord) return;
        if (imageDetailCache.current.has(currentImageRecord.id)) return;
        let cancelled = false;
        getImageDetail(batchDetail.id, currentImageRecord.id)
            .then((detail) => {
                if (cancelled) return;
                imageDetailCache.current.set(currentImageRecord.id, detail);
                bumpCache();
            })
            .catch(() => {
                if (cancelled) return;
                toast.error('Failed to load image annotations');
            });
        return () => {
            cancelled = true;
        };
    }, [batchDetail, currentImageRecord, bumpCache]);

    // ── Current image's full detail (with annotations), from cache ──────────
    // Reads through cacheVersion so it refreshes when an async fetch completes.
    const currentImageDetail = useMemo<AnalysisImageDetail | null>(() => {
        if (!currentImageRecord) return null;
        return imageDetailCache.current.get(currentImageRecord.id) ?? null;
        // cacheVersion is intentional — drives recompute when cache mutates.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentImageRecord, cacheVersion]);

    // ── Synthetic results array (for header / nav / content) ─────────────────
    // Maintains the existing DetectionResult shape so child components don't
    // need refactoring. Annotations come from the cache; empty until fetched.
    const resultCacheRef = useRef<{
        batchId: string | null;
        byImageId: Map<string, DetectionResult>;
        array: DetectionResult[];
    }>({ batchId: null, byImageId: new Map(), array: [] });
    const results = useMemo<DetectionResult[]>(() => {
        if (!batchDetail) {
            resultCacheRef.current = { batchId: null, byImageId: new Map(), array: [] };
            return [];
        }
        if (resultCacheRef.current.batchId !== batchDetail.id) {
            resultCacheRef.current = {
                batchId: batchDetail.id,
                byImageId: new Map(),
                array: [],
            };
        }
        const organism = (batchDetail.organism_type as Organism) ?? 'egg';
        const cache = resultCacheRef.current;
        const seenIds = new Set<string>();
        let changed = cache.array.length !== batchDetail.images.length;
        const nextArray = batchDetail.images.map((img) => {
            const cached = imageDetailCache.current.get(img.id);
            const annotations = (cached?.annotations ?? []) as unknown as BBox[];
            const overlayUrl = img.overlay_path
                ? `/analyses/${batchDetail.id}/images/${img.id}/overlay`
                : '';
            const previous = cache.byImageId.get(img.id);
            seenIds.add(img.id);
            if (
                previous &&
                previous.filename === img.original_filename &&
                previous.organism === organism &&
                previous.count === (img.count ?? 0) &&
                previous.avg_confidence === (img.avg_confidence ?? 0) &&
                previous.elapsed_seconds === (img.elapsed_secs ?? 0) &&
                previous.annotations === annotations &&
                previous.overlay_url === overlayUrl
            ) {
                return previous;
            }
            changed = true;
            const next = {
                filename: img.original_filename,
                organism,
                count: img.count ?? 0,
                avg_confidence: img.avg_confidence ?? 0,
                elapsed_seconds: img.elapsed_secs ?? 0,
                annotations,
                overlay_url: overlayUrl,
            };
            cache.byImageId.set(img.id, next);
            return next;
        });
        for (const imageId of cache.byImageId.keys()) {
            if (!seenIds.has(imageId)) {
                cache.byImageId.delete(imageId);
                changed = true;
            }
        }
        if (!changed) return cache.array;
        cache.array = nextArray;
        return nextArray;
    }, [batchDetail, cacheVersion]);

    const currentResult = results[currentIndex] ?? null;

    // ── Effective boxes (edited vs model) — both come from the lazy cache ───
    const modelBoxes = useMemo(
        () => (currentImageDetail?.annotations as BBox[] | null) ?? [],
        [currentImageDetail],
    );
    const editedBoxes = useMemo(
        () => (currentImageDetail?.edited_annotations as BBox[] | null) ?? null,
        [currentImageDetail],
    );

    /** The "true" baseline — edited if saved, otherwise model. */
    const baselineBoxes = useMemo((): BBox[] => {
        return editedBoxes ?? modelBoxes;
    }, [editedBoxes, modelBoxes]);

    /** History boxes (in-session edits, uncommitted). */
    const sessionBoxes = history.present;

    /** Boxes to render in view mode (filtered). Edit mode renders inside the editor. */
    const viewBoxes = useMemo((): BBox[] => {
        // View mode shows the persisted baseline (edited if saved, otherwise model),
        // with the confidence threshold applied to model-origin boxes only.
        return baselineBoxes.filter(
            (b) => b.origin === 'user' || b.confidence >= confidenceThreshold,
        );
    }, [baselineBoxes, confidenceThreshold]);

    // ── Reset session history when the image's data is loaded ────────────────
    // Gate on currentImageDetail (not currentImageRecord) so the reset fires
    // *after* the lazy cache fills — otherwise we'd reset history to [] before
    // annotations arrive and clobber the baseline as soon as they do.
    const baselineBoxesRef = useRef(baselineBoxes);
    useEffect(() => {
        baselineBoxesRef.current = baselineBoxes;
    }, [baselineBoxes]);
    useEffect(() => {
        const imageId = currentImageDetail?.id ?? null;
        if (previousImageIdRef.current === imageId) return;
        previousImageIdRef.current = imageId;
        setSelectedIdx(null);
        setEditorTool('drag');
        dispatchHistory({ type: 'reset', boxes: baselineBoxesRef.current });
    }, [currentImageDetail?.id]);

    // ── isDirty ─────────────────────────────────────────────────────────────
    const isDirty = useMemo(
        () => !boxesEqual(sessionBoxes, baselineBoxes),
        [sessionBoxes, baselineBoxes],
    );

    // ── Navigate with dirty guard ───────────────────────────────────────────
    // URL-driven: navigation pushes a new path (replace mode so Next/Prev
    // doesn't pollute history with one entry per image) — currentIndex is
    // derived from the URL's :imageId segment.
    const navigateToIndex = useCallback(
        (index: number) => {
            if (!batchDetail) return;
            const targetId = batchDetail.images[index]?.id;
            if (!targetId) return;
            navigate(buildUrl(batchDetail.id, targetId), { replace: true });
        },
        [batchDetail, navigate, buildUrl],
    );

    const confirmDirtyNav = useCallback(() => {
        setDirtyNavDialogOpen(false);
        if (pendingNavIdx === null) return;
        navigateToIndex(pendingNavIdx);
        setPendingNavIdx(null);
    }, [pendingNavIdx, navigateToIndex]);

    const cancelDirtyNav = useCallback(() => {
        setDirtyNavDialogOpen(false);
        setPendingNavIdx(null);
    }, []);

    // ── Save edits (debounced + sequence-guarded) ──────────────────────────
    // After a successful PUT, refresh just this image's cache entry — no need
    // to re-fetch the full batch. Per-image cost stays O(1).
    const saveSeqRef = useRef(0);
    const saveAbortRef = useRef<AbortController | null>(null);
    const handleSaveEdits = useCallback(
        async (args: SaveEditsArgs = {}) => {
            if (!batchDetail) return false;
            const batchId = batchDetail.id;
            const imageId = args.imageId ?? currentImageRecord?.id;
            if (!imageId) return false;
            const boxesToSave = args.boxesToSave ?? sessionBoxes;
            const cached = imageDetailCache.current.get(imageId);
            const baseline = (cached?.edited_annotations ??
                cached?.annotations ??
                []) as unknown as BBox[];
            if (!args.force && boxesEqual(boxesToSave, baseline)) return true;
            saveAbortRef.current?.abort();
            const controller = new AbortController();
            saveAbortRef.current = controller;
            const seq = ++saveSeqRef.current;
            setSavingEdits(true);
            try {
                await putEditedAnnotations(batchId, imageId, boxesToSave, controller.signal);
                if (seq !== saveSeqRef.current) return; // newer save in flight
                const updatedImage = await getImageDetail(batchId, imageId, controller.signal);
                if (seq !== saveSeqRef.current) return;
                imageDetailCache.current.set(imageId, updatedImage);
                if (currentImageRecord?.id === imageId) bumpCache();
                return true;
            } catch {
                if (!controller.signal.aborted && seq === saveSeqRef.current) {
                    toast.error('Failed to auto-save edits');
                }
                return false;
            } finally {
                if (seq === saveSeqRef.current) {
                    if (saveAbortRef.current === controller) saveAbortRef.current = null;
                    setSavingEdits(false);
                }
            }
        },
        [batchDetail, currentImageRecord?.id, sessionBoxes, bumpCache],
    );

    useEffect(() => {
        if (!editMode || !isDirty) return;
        const imageId = currentImageRecord?.id;
        if (!imageId) return;
        const boxesToSave = sessionBoxes;
        const t = setTimeout(() => {
            void handleSaveEdits({ imageId, boxesToSave, force: true });
        }, 500);
        return () => clearTimeout(t);
    }, [editMode, handleSaveEdits, isDirty, currentImageRecord?.id, sessionBoxes]);

    useEffect(() => {
        return () => {
            saveAbortRef.current?.abort();
            saveSeqRef.current += 1;
            saveAbortRef.current = null;
        };
    }, [currentImageRecord?.id]);

    const handleNavigate = useCallback(
        (index: number) => {
            if (!isDirty) {
                navigateToIndex(index);
                return;
            }
            const imageId = currentImageRecord?.id;
            const boxesToSave = sessionBoxes;
            void handleSaveEdits({ imageId, boxesToSave, force: true }).then((saved) => {
                if (saved) {
                    navigateToIndex(index);
                    return;
                }
                setPendingNavIdx(index);
                setDirtyNavDialogOpen(true);
            });
        },
        [currentImageRecord?.id, handleSaveEdits, isDirty, navigateToIndex, sessionBoxes],
    );

    // ── Reset to model ──────────────────────────────────────────────────────
    // Single-image cache update — same pattern as save edits.
    const handleResetToModel = useCallback(async () => {
        if (!batchDetail || !currentImageRecord) return;
        setResetDialogOpen(false);
        try {
            await resetEditedAnnotations(batchDetail.id, currentImageRecord.id);
            const updatedImage = await getImageDetail(batchDetail.id, currentImageRecord.id);
            imageDetailCache.current.set(currentImageRecord.id, updatedImage);
            bumpCache();
            const newBaseline = (updatedImage.annotations as BBox[] | null) ?? [];
            dispatchHistory({ type: 'reset', boxes: newBaseline });
            setSelectedIdx(null);
            toast.success('Reset to model output');
        } catch {
            toast.error('Failed to reset');
        }
    }, [batchDetail, currentImageRecord, bumpCache]);

    // ── Editor changes ──────────────────────────────────────────────────────
    // Called once per finished gesture (drag-end / commit). The editor handles
    // its own transient drag state internally so we don't pollute history.
    const handleEditorCommit = useCallback((newBoxes: BBox[]) => {
        dispatchHistory({ type: 'apply', boxes: newBoxes });
        // Finishing a drawn box (or any gesture) returns to drag-select so the
        // annotation toolbar — hidden while drawing — reappears immediately,
        // instead of waiting for the user to press Esc. The drawn box is
        // auto-selected by OverlayImage, which only surfaces handles/panel in
        // drag mode anyway.
        setEditorTool('drag');
    }, []);

    // ── Ctrl/Cmd-hold → reveal raw image (non-edit mode only) ─────────────
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

    // ── Keyboard shortcuts ──────────────────────────────────────────────────
    useEffect(() => {
        if (!editMode) return;

        function onKeyDown(e: KeyboardEvent) {
            const inputFocused =
                e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
            if (inputFocused) return;

            const platform =
                (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
                    ?.platform ??
                navigator.platform ??
                '';
            const isMac = platform.toUpperCase().includes('MAC');
            const mod = isMac ? e.metaKey : e.ctrlKey;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                if (selectedIdx !== null) {
                    const next = sessionBoxes.filter((_, i) => i !== selectedIdx);
                    dispatchHistory({ type: 'apply', boxes: next });
                    setSelectedIdx(null);
                }
                return;
            }

            if (mod && e.shiftKey && e.key === 'z') {
                e.preventDefault();
                dispatchHistory({ type: 'redo' });
                setSelectedIdx(null);
                return;
            }

            if (mod && e.key === 'z') {
                e.preventDefault();
                dispatchHistory({ type: 'undo' });
                setSelectedIdx(null);
                return;
            }

            if (e.key === 'd' || e.key === 'D') {
                e.preventDefault();
                setEditorTool((t) => (t === 'draw' ? 'drag' : 'draw'));
                setSelectedIdx(null);
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                if (editorTool !== 'drag') {
                    setEditorTool('drag');
                } else {
                    setSelectedIdx(null);
                }
                return;
            }

            if (mod && e.key === 's') {
                e.preventDefault();
                if (isDirty && !savingEdits) handleSaveEdits();
                return;
            }
        }

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [editMode, selectedIdx, sessionBoxes, editorTool, isDirty, savingEdits, handleSaveEdits]);

    // ── Raw image URL ───────────────────────────────────────────────────────
    const rawSrc = useMemo(() => {
        if (!currentResult) return '';
        if (batchDetail) {
            const imageRecord = currentImageRecord;
            if (imageRecord) return getAnalysesRawUrl(batchDetail.id, imageRecord.id);
        }
        return rawUrlByName[currentResult.filename] ?? '';
    }, [currentResult, batchDetail, currentImageRecord, rawUrlByName]);

    // ── StatBoard visible annotations ───────────────────────────────────────
    const visibleAnnotations = useMemo((): BBox[] => {
        const source = editMode ? sessionBoxes : baselineBoxes;
        return source.filter((b) => b.origin === 'user' || b.confidence >= confidenceThreshold);
    }, [editMode, sessionBoxes, baselineBoxes, confidenceThreshold]);

    // ── Undo/redo availability ───────────────────────────────────────────────
    const undoAvailable = canUndo(history);
    const redoAvailable = canRedo(history);

    const handleBack = useCallback(() => {
        setQuitDialogOpen(true);
    }, []);

    const handleQuitWithoutSaving = useCallback(() => {
        setQuitDialogOpen(false);
        navigate('/');
    }, [navigate]);

    const handleSaveAndQuit = useCallback(async () => {
        if (!batchDetail) {
            setQuitDialogOpen(false);
            navigate('/recorded');
            return;
        }
        try {
            // Persist any uncommitted annotation edits first.
            if (isDirty && !savingEdits) {
                await handleSaveEdits();
            }
            // If the batch is still in `processing` (e.g. processingManager
            // didn't get a chance to call /complete because the operator hit
            // Back early), promote it to `draft` so it shows up in Records.
            if (batchDetail.status === 'processing') {
                const updated = await completeBatch(batchDetail.id);
                const nextDetail = { ...batchDetail, status: updated.status };
                setBatchDetail(nextDetail);
                storeBatchDetail(nextDetail);
            }
            toast.success('Saved as draft');
        } catch {
            toast.error('Failed to save draft');
        } finally {
            setQuitDialogOpen(false);
            navigate(`/recorded?batch=${batchDetail.id}`);
        }
    }, [batchDetail, handleSaveEdits, isDirty, navigate, savingEdits]);

    const handleSelectDragTool = useCallback(() => {
        setEditorTool('drag');
    }, []);

    const handleToggleDrawTool = useCallback(() => {
        setEditorTool((tool) => (tool === 'draw' ? 'drag' : 'draw'));
        setSelectedIdx(null);
    }, []);

    const handleUndo = useCallback(() => {
        dispatchHistory({ type: 'undo' });
        setSelectedIdx(null);
    }, []);

    const handleRedo = useCallback(() => {
        dispatchHistory({ type: 'redo' });
        setSelectedIdx(null);
    }, []);

    const handleBackgroundClick = useCallback(() => {
        setSelectedIdx(null);
    }, []);

    const handleFinish = useCallback(async () => {
        if (!batchDetail || finishing) return;
        setFinishing(true);
        try {
            // Always persist any uncommitted edits before exiting, so the
            // autosave-debounce window can't drop in-flight changes.
            if (isDirty) {
                await handleSaveEdits();
            }
            // Promote draft → completed only on the first finish. When the
            // user is editing an already-completed batch (Continue from
            // /recorded), skip the finish call — the backend would 409.
            if (batchDetail.status !== 'completed') {
                const updated = await finishBatch(batchDetail.id);
                const nextDetail = { ...batchDetail, status: updated.status };
                setBatchDetail(nextDetail);
                storeBatchDetail(nextDetail);
            }
            toast.success('Saved to Records');
            navigate(`/recorded?batch=${batchDetail.id}`);
        } catch {
            toast.error('Failed to save to Records');
        } finally {
            setFinishing(false);
        }
    }, [batchDetail, finishing, handleSaveEdits, isDirty, navigate]);

    const handleImageDimensions = useCallback(() => {
        // Image dimensions are tracked internally by OverlayImage (Konva).
    }, []);

    // ── Render ──────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className={cn('flex h-screen items-center justify-center', className)}>
                <div className="flex items-center gap-3 text-muted-foreground">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    <span>Loading results…</span>
                </div>
            </div>
        );
    }

    // Polygon-based organisms (larvae/pupae) — completely separate flow.
    if (
        batchDetail &&
        (batchDetail.organism_type === 'larvae' || batchDetail.organism_type === 'pupae')
    ) {
        return (
            <LarvaeResultPanel
                organism={batchDetail.organism_type as Organism}
                className={className}
            />
        );
    }

    if (!currentResult) {
        return (
            <div className={cn('flex h-screen flex-col', className)}>
                <EmptyState
                    icon={Download}
                    title="No results found"
                    description="The session data may have expired. Start a new analysis to see results."
                    actionLabel="Start New Analysis"
                    onAction={() => navigate('/')}
                />
            </div>
        );
    }

    return (
        <div className={cn('flex h-screen flex-col', className)}>
            <ResultViewerHeader
                batchName={batchDetail?.name ?? null}
                batchStatus={batchDetail?.status}
                filename={currentResult.filename}
                currentIndex={currentIndex}
                total={results.length}
                canEdit={Boolean(batchDetail && currentImageRecord)}
                editMode={editMode}
                isDirty={isDirty}
                isSaved={batchDetail?.status === 'completed'}
                finishing={finishing}
                onBack={handleBack}
                onNavigate={handleNavigate}
                onFinish={handleFinish}
            />

            <ResultViewerContent
                organism={(batchDetail?.organism_type as Organism) ?? 'egg'}
                currentImageRecordId={currentImageRecord?.id ?? null}
                currentIndex={currentIndex}
                currentResult={currentResult}
                confidenceThreshold={confidenceThreshold}
                ctrlHeld={ctrlHeld}
                defaultClass={defaultClass}
                editMode={editMode}
                editorTool={editorTool}
                modelBoxes={modelBoxes}
                processingConfig={processingConfig}
                redoAvailable={redoAvailable}
                savingEdits={savingEdits}
                selectedIdx={selectedIdx}
                sessionBoxes={sessionBoxes}
                rawSrc={rawSrc}
                undoAvailable={undoAvailable}
                viewBoxes={viewBoxes}
                visibleAnnotations={visibleAnnotations}
                onBackgroundClick={
                    editMode && editorTool === 'drag' ? handleBackgroundClick : undefined
                }
                onDimensions={handleImageDimensions}
                onSelect={setSelectedIdx}
                onCommit={handleEditorCommit}
                onConfidenceChange={setConfidenceThreshold}
                onOpenResetDialog={() => setResetDialogOpen(true)}
                onRedo={handleRedo}
                onSelectDragTool={handleSelectDragTool}
                onToggleDrawTool={handleToggleDrawTool}
                onUndo={handleUndo}
                onSave={isDirty ? () => void handleSaveEdits() : undefined}
                saveDirty={isDirty}
            />

            <ResultViewerDialogs
                dirtyNavDialogOpen={dirtyNavDialogOpen}
                quitDialogOpen={quitDialogOpen}
                resetDialogOpen={resetDialogOpen}
                onDirtyNavOpenChange={setDirtyNavDialogOpen}
                onQuitDialogOpenChange={setQuitDialogOpen}
                onResetDialogOpenChange={setResetDialogOpen}
                onKeepEditing={cancelDirtyNav}
                onDiscardEdits={confirmDirtyNav}
                onQuitWithoutSaving={handleQuitWithoutSaving}
                onSaveAndQuit={handleSaveAndQuit}
                onCancelReset={() => setResetDialogOpen(false)}
                onConfirmReset={handleResetToModel}
                saveAndQuitDisabled={savingEdits}
            />
        </div>
    );
}
