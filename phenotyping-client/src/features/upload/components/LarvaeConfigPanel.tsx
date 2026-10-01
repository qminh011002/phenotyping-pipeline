// LarvaeConfigPanel — inference settings sheet for the polygon organisms
// (larvae and pupae).
//
// Values come from GET /config/{organism} and are written back with PUT, so
// the sheet shows what the server will actually use — and the batch's config
// snapshot records the same numbers.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
    Sheet,
    SheetBody,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { Spinner } from '@/components/common/Spinner';
import { getPolygonConfig, updatePolygonConfig } from '@/services/api';
import { organismMeta } from '@/lib/organism';
import type { CenterlineMethod, Device, LarvaeConfig, PolygonConfigUpdate } from '@/types/api';

import {
    LabeledField,
    NumberField,
    SettingsError,
    SettingsGroup,
    SliderField,
} from './settingsFields';

const TOOLTIPS = {
    confidence_threshold:
        'Minimum confidence score for a detection to be kept. Lower values detect more objects but may include false positives.',
    tile_size:
        'Size of each square tile in pixels. Images are split into overlapping tiles for inference. Must be a multiple of 32.',
    overlap:
        'Overlap ratio between adjacent tiles (0.0–0.9). Higher overlap improves detection near tile boundaries but increases compute.',
    min_mask_size: 'Filter out segmentation masks smaller than this area in pixels².',
    mwis_overlap_threshold:
        'Polygon-IoU above which two masks compete in MWIS deduplication. Higher values keep more overlapping masks.',
    batch_size:
        'Number of tiles processed in parallel per inference batch. Higher values are faster but use more memory.',
    calibration_object_w_mm:
        'Width of the green calibration rectangle in millimeters. Used to derive mm/px scale.',
    calibration_object_h_mm:
        'Height of the green calibration rectangle in millimeters. Used to derive mm/px scale.',
    device: 'Device used for inference. CUDA is faster when a GPU is available; CPU is the safe default.',
    centerline_method:
        'Centerline extraction algorithm. Pipeline-compat (distance-ridge Dijkstra + polynomial fit) reproduces the pipeline’s length numbers exactly — use this to match the reference. Hybrid (medial axis + 2-pass geodesic + B-spline) is more robust on curved larvae but its B-spline smoothing shortens the curve by ~15%. Legacy uses medial-axis longest path with Dijkstra fallback.',
    sam_enabled:
        'Refine YOLO polygons with SAM after detection. Gives tighter pixel-level boundaries. Only used by “Count + measure” runs — “Count only” runs always skip it, and you can refine later from the result viewer.',
} as const;

/** The fields this sheet edits — a flat view of the server config. */
interface Draft {
    device: Device;
    tile_size: number;
    overlap: number;
    confidence_threshold: number;
    min_mask_size: number;
    mwis_overlap_threshold: number;
    batch_size: number;
    calibration_object_w_mm: number;
    calibration_object_h_mm: number;
    centerline_method: CenterlineMethod;
    sam_enabled: boolean;
}

function toDraft(cfg: LarvaeConfig): Draft {
    return {
        device: cfg.device,
        tile_size: cfg.tile_size,
        overlap: cfg.overlap,
        confidence_threshold: cfg.confidence_threshold,
        min_mask_size: cfg.min_mask_size,
        mwis_overlap_threshold: cfg.mwis_overlap_threshold,
        batch_size: cfg.batch_size,
        calibration_object_w_mm: cfg.calibration_object_w_mm,
        calibration_object_h_mm: cfg.calibration_object_h_mm,
        centerline_method: cfg.centerline_method ?? 'pipeline_compat',
        sam_enabled: cfg.sam?.enabled ?? true,
    };
}

function validate(draft: Draft): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!Number.isInteger(draft.tile_size) || draft.tile_size < 128 || draft.tile_size > 2048) {
        errs.tile_size = 'Must be an integer between 128 and 2048';
    } else if (draft.tile_size % 32 !== 0) {
        errs.tile_size = 'Must be a multiple of 32';
    }
    if (draft.overlap < 0 || draft.overlap > 0.9) {
        errs.overlap = 'Must be between 0.0 and 0.9';
    }
    if (draft.confidence_threshold < 0.01 || draft.confidence_threshold > 1.0) {
        errs.confidence_threshold = 'Must be between 0.01 and 1.0';
    }
    if (!Number.isInteger(draft.min_mask_size) || draft.min_mask_size < 1) {
        errs.min_mask_size = 'Must be a positive integer';
    }
    if (draft.mwis_overlap_threshold <= 0 || draft.mwis_overlap_threshold >= 1) {
        errs.mwis_overlap_threshold = 'Must be strictly between 0 and 1';
    }
    if (!Number.isInteger(draft.batch_size) || draft.batch_size < 1 || draft.batch_size > 64) {
        errs.batch_size = 'Must be an integer between 1 and 64';
    }
    if (draft.calibration_object_w_mm <= 0) {
        errs.calibration_object_w_mm = 'Must be greater than 0';
    }
    if (draft.calibration_object_h_mm <= 0) {
        errs.calibration_object_h_mm = 'Must be greater than 0';
    }
    return errs;
}

/** Only the fields that differ from what the server has. */
function diff(draft: Draft, saved: Draft): PolygonConfigUpdate {
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(draft) as Array<keyof Draft>) {
        if (draft[key] !== saved[key]) patch[key] = draft[key];
    }
    return patch as PolygonConfigUpdate;
}

interface LarvaeConfigPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved?: (config: LarvaeConfig) => void;
    /** Which polygon organism's config to edit. */
    organism?: 'larvae' | 'pupae';
}

export function LarvaeConfigPanel({
    open,
    onOpenChange,
    onSaved,
    organism = 'larvae',
}: LarvaeConfigPanelProps) {
    const queryClient = useQueryClient();
    const queryKey = ['inference-config', organism];
    const query = useQuery({
        queryKey,
        queryFn: ({ signal }) => getPolygonConfig(organism, signal),
        enabled: open,
        staleTime: 0,
    });

    const saved = query.data ? toDraft(query.data) : null;
    const [draft, setDraft] = useState<Draft | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);

    // (Re)seed the form from the server every time the sheet opens or a fresh
    // config arrives — another tab may have changed it.
    useEffect(() => {
        if (open && query.data) {
            setDraft(toDraft(query.data));
            setFieldErrors({});
        }
    }, [open, query.data]);

    function update<K extends keyof Draft>(key: K, value: Draft[K]) {
        if (!draft) return;
        const next = { ...draft, [key]: value };
        setDraft(next);
        // Re-validate just this field so its message clears as soon as it's fixed.
        const message = validate(next)[key];
        setFieldErrors((errs) => {
            const { [key]: _removed, ...rest } = errs;
            return message ? { ...rest, [key]: message } : rest;
        });
    }

    async function handleApply() {
        if (!draft || !saved) return;
        const errs = validate(draft);
        setFieldErrors(errs);
        if (Object.keys(errs).length > 0) return;

        const patch = diff(draft, saved);
        if (Object.keys(patch).length === 0) {
            onOpenChange(false);
            return;
        }
        setSaving(true);
        try {
            const updated = await updatePolygonConfig(organism, patch);
            queryClient.setQueryData(queryKey, updated);
            onSaved?.(updated);
            onOpenChange(false);
        } catch (err) {
            toast.error(`Failed to save ${organism} settings`, {
                description: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setSaving(false);
        }
    }

    function handleReset() {
        if (saved) setDraft(saved);
        setFieldErrors({});
    }

    const label = organismMeta(organism).label;
    const isDirty = draft !== null && saved !== null && Object.keys(diff(draft, saved)).length > 0;

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent size="md">
                <SheetHeader>
                    <SheetTitle>{label} inference settings</SheetTitle>
                    <SheetDescription>
                        {draft === null && !query.isError
                            ? 'Loading configuration…'
                            : 'Adjust how images are analyzed. Changes apply to the next analysis run.'}
                    </SheetDescription>
                </SheetHeader>

                {draft === null ? (
                    <SheetBody>
                        {query.isError ? (
                            <div className="space-y-3">
                                <SettingsError message={String(query.error)} />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void query.refetch()}
                                >
                                    Retry
                                </Button>
                            </div>
                        ) : (
                            <div className="flex flex-1 items-center justify-center py-16">
                                <Spinner />
                            </div>
                        )}
                    </SheetBody>
                ) : (
                    <TooltipProvider delayDuration={300}>
                        <SheetBody>
                            <div className="flex flex-col gap-7">
                                <SettingsGroup title="Detection">
                                    <LabeledField
                                        htmlFor="larvae-conf-threshold"
                                        label="Confidence threshold"
                                        tooltip={TOOLTIPS.confidence_threshold}
                                        error={fieldErrors.confidence_threshold}
                                    >
                                        <SliderField
                                            id="larvae-conf-threshold"
                                            min={0.01}
                                            max={1.0}
                                            step={0.05}
                                            value={draft.confidence_threshold}
                                            onChange={(v) => update('confidence_threshold', v)}
                                            format={(v) => v.toFixed(2)}
                                            disabled={saving}
                                        />
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="larvae-min-mask"
                                        label="Min mask size"
                                        tooltip={TOOLTIPS.min_mask_size}
                                        error={fieldErrors.min_mask_size}
                                    >
                                        <NumberField
                                            id="larvae-min-mask"
                                            value={draft.min_mask_size}
                                            onChange={(v) => update('min_mask_size', v)}
                                            step={10}
                                            min={1}
                                            max={10000}
                                            suffix="px²"
                                            disabled={saving}
                                        />
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="larvae-mwis"
                                        label="MWIS overlap threshold"
                                        tooltip={TOOLTIPS.mwis_overlap_threshold}
                                        error={fieldErrors.mwis_overlap_threshold}
                                    >
                                        <SliderField
                                            id="larvae-mwis"
                                            min={0.05}
                                            max={0.95}
                                            step={0.05}
                                            value={draft.mwis_overlap_threshold}
                                            onChange={(v) => update('mwis_overlap_threshold', v)}
                                            format={(v) => v.toFixed(2)}
                                            disabled={saving}
                                        />
                                    </LabeledField>
                                </SettingsGroup>

                                <SettingsGroup title="Tiling">
                                    <LabeledField
                                        htmlFor="larvae-tile-size"
                                        label="Tile size"
                                        tooltip={TOOLTIPS.tile_size}
                                        error={fieldErrors.tile_size}
                                    >
                                        <NumberField
                                            id="larvae-tile-size"
                                            value={draft.tile_size}
                                            onChange={(v) => update('tile_size', v)}
                                            step={32}
                                            min={128}
                                            max={2048}
                                            suffix="px"
                                            disabled={saving}
                                        />
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="larvae-overlap"
                                        label="Tile overlap"
                                        tooltip={TOOLTIPS.overlap}
                                        error={fieldErrors.overlap}
                                        hint="More overlap means more tiles per image — the main driver of processing time."
                                    >
                                        <SliderField
                                            id="larvae-overlap"
                                            min={0.0}
                                            max={0.9}
                                            step={0.05}
                                            value={draft.overlap}
                                            onChange={(v) => update('overlap', v)}
                                            format={(v) => `${Math.round(v * 100)}%`}
                                            disabled={saving}
                                        />
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="larvae-batch-size"
                                        label="Batch size"
                                        tooltip={TOOLTIPS.batch_size}
                                        error={fieldErrors.batch_size}
                                        hint="Higher values use more memory but process faster."
                                    >
                                        <NumberField
                                            id="larvae-batch-size"
                                            value={draft.batch_size}
                                            onChange={(v) => update('batch_size', v)}
                                            step={1}
                                            min={1}
                                            max={64}
                                            disabled={saving}
                                        />
                                    </LabeledField>
                                </SettingsGroup>

                                <SettingsGroup
                                    title="Measurement"
                                    description="Used when sizes are measured — during a “Count + measure” run, or later from the result viewer."
                                >
                                    <LabeledField
                                        htmlFor="larvae-sam-enabled"
                                        label="SAM polygon refinement"
                                        tooltip={TOOLTIPS.sam_enabled}
                                        hint={
                                            draft.sam_enabled
                                                ? 'On — “Count + measure” runs refine outlines with SAM.'
                                                : 'Off — “Count + measure” runs keep raw YOLO polygons (faster, coarser).'
                                        }
                                    >
                                        <div className="flex items-center gap-3">
                                            <Switch
                                                id="larvae-sam-enabled"
                                                checked={draft.sam_enabled}
                                                onCheckedChange={(v) => update('sam_enabled', v)}
                                                disabled={saving}
                                            />
                                            <span className="text-sm text-muted-foreground">
                                                {draft.sam_enabled ? 'Enabled' : 'Disabled'}
                                            </span>
                                        </div>
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="larvae-centerline-method"
                                        label="Centerline method"
                                        tooltip={TOOLTIPS.centerline_method}
                                        hint="Pipeline-compat is recommended to match the reference."
                                    >
                                        <Select
                                            value={draft.centerline_method}
                                            onValueChange={(v) =>
                                                update('centerline_method', v as CenterlineMethod)
                                            }
                                            disabled={saving}
                                        >
                                            <SelectTrigger
                                                id="larvae-centerline-method"
                                                className="w-full"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="pipeline_compat">
                                                    Pipeline-compat (matches reference output)
                                                </SelectItem>
                                                <SelectItem value="hybrid">
                                                    Hybrid (medial axis + geodesic + B-spline)
                                                </SelectItem>
                                                <SelectItem value="legacy_dijkstra">
                                                    Legacy (medial-axis longest path)
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </LabeledField>

                                    <div className="space-y-4 rounded-lg border border-border bg-muted/40 p-4">
                                        <p className="text-xs font-medium text-muted-foreground">
                                            Calibration object (green rectangle)
                                        </p>
                                        <LabeledField
                                            htmlFor="larvae-cal-w"
                                            label="Width (mm)"
                                            tooltip={TOOLTIPS.calibration_object_w_mm}
                                            error={fieldErrors.calibration_object_w_mm}
                                        >
                                            <NumberField
                                                id="larvae-cal-w"
                                                value={draft.calibration_object_w_mm}
                                                onChange={(v) =>
                                                    update('calibration_object_w_mm', v)
                                                }
                                                step={1}
                                                min={1}
                                                suffix="mm"
                                                disabled={saving}
                                            />
                                        </LabeledField>
                                        <LabeledField
                                            htmlFor="larvae-cal-h"
                                            label="Height (mm)"
                                            tooltip={TOOLTIPS.calibration_object_h_mm}
                                            error={fieldErrors.calibration_object_h_mm}
                                        >
                                            <NumberField
                                                id="larvae-cal-h"
                                                value={draft.calibration_object_h_mm}
                                                onChange={(v) =>
                                                    update('calibration_object_h_mm', v)
                                                }
                                                step={1}
                                                min={1}
                                                suffix="mm"
                                                disabled={saving}
                                            />
                                        </LabeledField>
                                    </div>
                                </SettingsGroup>

                                <SettingsGroup title="Compute">
                                    <LabeledField
                                        htmlFor="larvae-device"
                                        label="Device"
                                        tooltip={TOOLTIPS.device}
                                        hint="A device change takes effect after the backend restarts."
                                    >
                                        <Select
                                            value={draft.device}
                                            onValueChange={(v) => update('device', v as Device)}
                                            disabled={saving}
                                        >
                                            <SelectTrigger id="larvae-device" className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="cpu">CPU</SelectItem>
                                                <SelectItem value="cuda:0">CUDA (GPU 0)</SelectItem>
                                                {draft.device !== 'cpu' &&
                                                    draft.device !== 'cuda:0' && (
                                                        <SelectItem value={draft.device}>
                                                            {draft.device}
                                                        </SelectItem>
                                                    )}
                                            </SelectContent>
                                        </Select>
                                    </LabeledField>
                                </SettingsGroup>
                            </div>
                        </SheetBody>

                        <SheetFooter>
                            <Button
                                variant="outline"
                                onClick={handleReset}
                                disabled={saving || !isDirty}
                                className="flex-1"
                            >
                                Reset
                            </Button>
                            <Button
                                onClick={handleApply}
                                loading={saving}
                                disabled={Object.keys(fieldErrors).length > 0}
                                className="flex-1"
                            >
                                Apply
                            </Button>
                        </SheetFooter>
                    </TooltipProvider>
                )}
            </SheetContent>
        </Sheet>
    );
}
