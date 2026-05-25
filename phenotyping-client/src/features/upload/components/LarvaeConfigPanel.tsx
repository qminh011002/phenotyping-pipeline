// LarvaeConfigPanel — inference settings sheet for larvae batches.
//
// Mirrors EggConfigPanel but renders the larvae-specific knobs (mask size,
// MWIS overlap, calibration object dimensions). There is no GET/PUT /config
// endpoint for larvae yet, so this panel keeps its values in sessionStorage
// and feeds them into `config_snapshot` when the batch is created.

import { useState, useEffect } from 'react';
import { Info } from 'lucide-react';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetBody,
    SheetFooter,
    SheetTitle,
    SheetDescription,
} from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { updateLarvaeConfig } from '@/services/api';
import {
    loadLarvaeProcessingConfig,
    storeLarvaeProcessingConfig,
} from '@/features/upload/lib/processingSession';
import type { CenterlineMethod, Device, LarvaeConfig } from '@/types/api';

const TOOLTIPS: Record<string, string> = {
    confidence_threshold:
        'Minimum confidence score for a detection to be kept. Lower values detect more larvae but may include false positives.',
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
    device:
        'Device used for inference. CUDA is faster when a GPU is available; CPU is the safe default.',
    centerline_method:
        'Centerline extraction algorithm. Pipeline-compat (distance-ridge Dijkstra + polynomial fit) reproduces the pipeline’s length numbers exactly — use this to match the reference. Hybrid (medial axis + 2-pass geodesic + B-spline) is more robust on curved larvae but its B-spline smoothing shortens the curve by ~15%. Legacy uses medial-axis longest path with Dijkstra fallback.',
    sam_enabled:
        'Refine YOLO polygons with SAM after detection. Gives tighter pixel-level boundaries; turn off to skip the SAM step entirely (faster, but coarser polygons).',
};

const DEFAULTS: LarvaeConfig = {
    model: null,
    device: 'cpu',
    tile_size: 1024,
    overlap: 0.2,
    confidence_threshold: 0.4,
    min_mask_size: 100,
    mwis_overlap_threshold: 0.5,
    mwis_score_metric: 'confidence_x_area',
    batch_size: 8,
    calibration_object_w_mm: 405,
    calibration_object_h_mm: 317,
    enable_weight: false,
    centerline_method: 'pipeline_compat',
    centerline_min_branch_ratio: 0.15,
    centerline_n_output_points: 100,
    centerline_smoothness: null,
};

function loadInitialConfig(): LarvaeConfig {
    const stored = loadLarvaeProcessingConfig();
    if (!stored) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(stored as Partial<LarvaeConfig>) };
}

interface LabeledFieldProps {
    htmlFor?: string;
    label: string;
    tooltip: string;
    children: React.ReactNode;
    error?: string;
    hint?: string;
}

function LabeledField({ htmlFor, label, tooltip, children, error, hint }: LabeledFieldProps) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
                {htmlFor ? (
                    <Label htmlFor={htmlFor} className="text-sm font-medium cursor-help">
                        {label}
                    </Label>
                ) : (
                    <span className="text-sm font-medium">{label}</span>
                )}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-xs text-xs leading-relaxed">
                        {tooltip}
                    </TooltipContent>
                </Tooltip>
            </div>
            {children}
            {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
            {error && (
                <p className="text-xs text-destructive" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

interface NumberFieldProps {
    id: string;
    value: number;
    onChange: (value: number) => void;
    step?: number;
    min?: number;
    max?: number;
    suffix?: string;
}

function NumberField({ id, value, onChange, step = 1, min, max, suffix }: NumberFieldProps) {
    return (
        <div className="flex items-center gap-2">
            <Input
                id={id}
                type="number"
                value={value}
                step={step}
                min={min}
                max={max}
                onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) onChange(v);
                }}
                className="w-28 font-mono"
            />
            {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
        </div>
    );
}

interface LarvaeConfigPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved?: (config: LarvaeConfig) => void;
}

function validate(config: LarvaeConfig): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!Number.isInteger(config.tile_size) || config.tile_size < 128 || config.tile_size > 2048) {
        errs.tile_size = 'Must be an integer between 128 and 2048';
    } else if (config.tile_size % 32 !== 0) {
        errs.tile_size = 'Must be a multiple of 32';
    }
    if (config.overlap < 0 || config.overlap > 0.9) {
        errs.overlap = 'Must be between 0.0 and 0.9';
    }
    if (config.confidence_threshold < 0.01 || config.confidence_threshold > 1.0) {
        errs.confidence_threshold = 'Must be between 0.01 and 1.0';
    }
    if (!Number.isInteger(config.min_mask_size) || config.min_mask_size < 1) {
        errs.min_mask_size = 'Must be a positive integer';
    }
    if (config.mwis_overlap_threshold <= 0 || config.mwis_overlap_threshold >= 1) {
        errs.mwis_overlap_threshold = 'Must be strictly between 0 and 1';
    }
    if (
        !Number.isInteger(config.batch_size) ||
        config.batch_size < 1 ||
        config.batch_size > 64
    ) {
        errs.batch_size = 'Must be an integer between 1 and 64';
    }
    if (config.calibration_object_w_mm <= 0) {
        errs.calibration_object_w_mm = 'Must be greater than 0';
    }
    if (config.calibration_object_h_mm <= 0) {
        errs.calibration_object_h_mm = 'Must be greater than 0';
    }
    return errs;
}

export function LarvaeConfigPanel({ open, onOpenChange, onSaved }: LarvaeConfigPanelProps) {
    const [local, setLocal] = useState<LarvaeConfig>(() => loadInitialConfig());
    const [saved, setSaved] = useState<LarvaeConfig>(() => loadInitialConfig());
    // SAM enable is not part of LarvaeConfig (it lives under larvae.sam.enabled
    // in YAML). Tracked separately so the existing config shape stays intact.
    const [samEnabled, setSamEnabled] = useState<boolean>(true);
    const [savedSamEnabled, setSavedSamEnabled] = useState<boolean>(true);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    // Re-read on open in case another tab/page wrote a different snapshot.
    useEffect(() => {
        if (open) {
            const next = loadInitialConfig();
            setLocal(next);
            setSaved(next);
            const storedSam =
                (loadLarvaeProcessingConfig() as { sam_enabled?: boolean } | null)
                    ?.sam_enabled;
            const initSam = storedSam === undefined ? true : Boolean(storedSam);
            setSamEnabled(initSam);
            setSavedSamEnabled(initSam);
            setFieldErrors({});
        }
    }, [open]);

    function update<K extends keyof LarvaeConfig>(key: K, value: LarvaeConfig[K]) {
        setLocal((prev) => ({ ...prev, [key]: value }));
    }

    async function handleApply() {
        const errs = validate(local);
        setFieldErrors(errs);
        if (Object.keys(errs).length > 0) return;
        storeLarvaeProcessingConfig({
            ...(local as unknown as Record<string, unknown>),
            sam_enabled: samEnabled,
        });

        // Persist the runtime knobs to the backend so the next inference run
        // picks them up — the other knobs are still sessionStorage only
        // (snapshotted into config_snapshot at batch creation).
        const patch: { centerline_method?: CenterlineMethod; sam_enabled?: boolean } = {};
        if (local.centerline_method !== saved.centerline_method) {
            patch.centerline_method = local.centerline_method;
        }
        if (samEnabled !== savedSamEnabled) {
            patch.sam_enabled = samEnabled;
        }
        if (Object.keys(patch).length > 0) {
            try {
                await updateLarvaeConfig(patch);
            } catch (err) {
                toast.error('Failed to save larvae config', {
                    description: err instanceof Error ? err.message : String(err),
                });
                return;
            }
        }

        setSaved(local);
        setSavedSamEnabled(samEnabled);
        onSaved?.(local);
        onOpenChange(false);
    }

    function handleReset() {
        setLocal({ ...DEFAULTS });
        setFieldErrors({});
    }

    const isDirty =
        JSON.stringify(local) !== JSON.stringify(saved) || samEnabled !== savedSamEnabled;

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent size="md">
                <SheetHeader>
                    <SheetTitle>Larvae Inference Settings</SheetTitle>
                    <SheetDescription>
                        Adjust how images are analyzed. Changes apply to the next analysis run.
                    </SheetDescription>
                </SheetHeader>

                <TooltipProvider delayDuration={300}>
                    <SheetBody>
                        <div className="flex flex-col gap-5">
                            <LabeledField
                                htmlFor="larvae-conf-threshold"
                                label="Confidence Threshold"
                                tooltip={TOOLTIPS.confidence_threshold}
                                error={fieldErrors.confidence_threshold}
                            >
                                <div className="flex items-center gap-3">
                                    <Slider
                                        id="larvae-conf-threshold"
                                        min={0.01}
                                        max={1.0}
                                        step={0.05}
                                        value={[local.confidence_threshold]}
                                        onValueChange={([v]) => update('confidence_threshold', v)}
                                        className="flex-1"
                                    />
                                    <span className="w-12 text-right font-mono text-sm tabular-nums">
                                        {local.confidence_threshold.toFixed(2)}
                                    </span>
                                </div>
                            </LabeledField>

                            <LabeledField
                                htmlFor="larvae-tile-size"
                                label="Tile Size"
                                tooltip={TOOLTIPS.tile_size}
                                error={fieldErrors.tile_size}
                            >
                                <NumberField
                                    id="larvae-tile-size"
                                    value={local.tile_size}
                                    onChange={(v) => update('tile_size', v)}
                                    step={32}
                                    min={128}
                                    max={2048}
                                    suffix="px"
                                />
                            </LabeledField>

                            <LabeledField
                                htmlFor="larvae-overlap"
                                label="Tile Overlap"
                                tooltip={TOOLTIPS.overlap}
                                error={fieldErrors.overlap}
                            >
                                <div className="flex items-center gap-3">
                                    <Slider
                                        id="larvae-overlap"
                                        min={0.0}
                                        max={0.9}
                                        step={0.05}
                                        value={[local.overlap]}
                                        onValueChange={([v]) => update('overlap', v)}
                                        className="flex-1"
                                    />
                                    <span className="w-12 text-right font-mono text-sm tabular-nums">
                                        {Math.round(local.overlap * 100)}%
                                    </span>
                                </div>
                            </LabeledField>

                            <LabeledField
                                htmlFor="larvae-min-mask"
                                label="Min Mask Size"
                                tooltip={TOOLTIPS.min_mask_size}
                                error={fieldErrors.min_mask_size}
                            >
                                <NumberField
                                    id="larvae-min-mask"
                                    value={local.min_mask_size}
                                    onChange={(v) => update('min_mask_size', v)}
                                    step={10}
                                    min={1}
                                    max={10000}
                                    suffix="px²"
                                />
                            </LabeledField>

                            <LabeledField
                                htmlFor="larvae-mwis"
                                label="MWIS Overlap Threshold"
                                tooltip={TOOLTIPS.mwis_overlap_threshold}
                                error={fieldErrors.mwis_overlap_threshold}
                            >
                                <div className="flex items-center gap-3">
                                    <Slider
                                        id="larvae-mwis"
                                        min={0.05}
                                        max={0.95}
                                        step={0.05}
                                        value={[local.mwis_overlap_threshold]}
                                        onValueChange={([v]) =>
                                            update('mwis_overlap_threshold', v)
                                        }
                                        className="flex-1"
                                    />
                                    <span className="w-12 text-right font-mono text-sm tabular-nums">
                                        {local.mwis_overlap_threshold.toFixed(2)}
                                    </span>
                                </div>
                            </LabeledField>

                            <div className="space-y-4 rounded-md border border-border bg-muted/30 p-4">
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
                                        value={local.calibration_object_w_mm}
                                        onChange={(v) => update('calibration_object_w_mm', v)}
                                        step={1}
                                        min={1}
                                        suffix="mm"
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
                                        value={local.calibration_object_h_mm}
                                        onChange={(v) => update('calibration_object_h_mm', v)}
                                        step={1}
                                        min={1}
                                        suffix="mm"
                                    />
                                </LabeledField>
                            </div>

                            <LabeledField
                                htmlFor="larvae-device"
                                label="Device"
                                tooltip={TOOLTIPS.device}
                            >
                                <Select
                                    value={local.device}
                                    onValueChange={(v) => update('device', v as Device)}
                                >
                                    <SelectTrigger id="larvae-device" className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="cpu">CPU</SelectItem>
                                        <SelectItem value="cuda:0">CUDA (GPU 0)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </LabeledField>

                            <LabeledField
                                htmlFor="larvae-sam-enabled"
                                label="SAM polygon refinement"
                                tooltip={TOOLTIPS.sam_enabled}
                                hint={
                                    samEnabled
                                        ? 'On — polygons refined by SAM after YOLO.'
                                        : 'Off — using raw YOLO polygons (faster, coarser).'
                                }
                            >
                                <div className="flex items-center gap-3">
                                    <Switch
                                        id="larvae-sam-enabled"
                                        checked={samEnabled}
                                        onCheckedChange={setSamEnabled}
                                    />
                                    <span className="text-sm text-muted-foreground">
                                        {samEnabled ? 'Enabled' : 'Disabled'}
                                    </span>
                                </div>
                            </LabeledField>

                            <LabeledField
                                htmlFor="larvae-centerline-method"
                                label="Centerline Method"
                                tooltip={TOOLTIPS.centerline_method}
                                hint="Pipeline-compat is recommended to match the reference."
                            >
                                <Select
                                    value={local.centerline_method ?? 'pipeline_compat'}
                                    onValueChange={(v) =>
                                        update('centerline_method', v as CenterlineMethod)
                                    }
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

                            <LabeledField
                                htmlFor="larvae-batch-size"
                                label="Batch Size"
                                tooltip={TOOLTIPS.batch_size}
                                error={fieldErrors.batch_size}
                                hint="Higher values use more memory but process faster."
                            >
                                <NumberField
                                    id="larvae-batch-size"
                                    value={local.batch_size}
                                    onChange={(v) => update('batch_size', v)}
                                    step={1}
                                    min={1}
                                    max={64}
                                />
                            </LabeledField>
                        </div>
                    </SheetBody>

                    <SheetFooter>
                        <Button
                            variant="outline"
                            onClick={handleReset}
                            disabled={!isDirty}
                            className="flex-1"
                        >
                            Reset
                        </Button>
                        <Button
                            onClick={handleApply}
                            disabled={Object.keys(fieldErrors).length > 0}
                            className="flex-1"
                        >
                            Apply
                        </Button>
                    </SheetFooter>
                </TooltipProvider>
            </SheetContent>
        </Sheet>
    );
}
