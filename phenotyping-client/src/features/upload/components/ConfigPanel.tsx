// ConfigPanel — inference settings sheet for the bbox organisms (egg and
// neonate). Values come from GET /config[/neonate] and are written back with
// PUT, so what the sheet shows is what the next run uses.

import { useEffect, useState } from 'react';

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
import { Spinner } from '@/components/common/Spinner';
import { useConfig, validateBboxConfig } from '@/features/upload/hooks/useConfig';
import { organismMeta } from '@/lib/organism';
import type { EggConfig } from '@/types/api';

import {
    LabeledField,
    NumberField,
    SettingsError,
    SettingsGroup,
    SliderField,
} from './settingsFields';

// ── Parameter tooltip content (from infer_egg_doc.md) ──────────────────────────

const TOOLTIPS: Record<string, string> = {
    confidence_threshold:
        'Minimum confidence score for a detection to be counted. Lower values detect more objects but may include false positives.',
    dedup_mode:
        'How to handle overlapping tile detections:\n• "Center Zone" (recommended): keeps detection only if its center falls in a tile\'s valid zone — O(N), no duplicates by design.\n• "Edge NMS": skips edge-touching boxes then applies global NMS as a safety net — O(N²), legacy approach.',
    tile_size:
        'Size of each square tile in pixels. Images are split into overlapping tiles for inference. Larger tiles cover more area but require more memory. Must be a multiple of 32.',
    overlap:
        'Overlap ratio between adjacent tiles (0.0–0.9). Higher overlap improves detection near tile boundaries but increases computation. 0.5 recommended for center_zone.',
    min_box_area:
        'Filter out bounding boxes smaller than this area in pixels². Helps remove spurious tiny detections.',
    batch_size:
        'Number of tiles processed in parallel per inference batch. Higher values are faster but use more memory.',
    edge_margin:
        "Skip detections whose bounding box is within this many pixels of a tile edge. Only applies when dedup_mode is 'edge_nms'.",
    nms_iou_threshold:
        "IoU threshold for global NMS (deduplication pass). Only applies when dedup_mode is 'edge_nms'. Higher values are more aggressive at merging overlapping boxes.",
};

interface ConfigPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved?: (config: EggConfig) => void;
    /** Which bbox organism's config to edit. */
    organism?: 'egg' | 'neonate';
}

export function ConfigPanel({ open, onOpenChange, onSaved, organism = 'egg' }: ConfigPanelProps) {
    const { config, saving, error, saveConfig, loadConfig } = useConfig(organism, open);

    // Local draft of the form; `config` stays the last value read from the server.
    const [local, setLocal] = useState<EggConfig | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    useEffect(() => {
        if (config) setLocal(config);
    }, [config]);

    function updateField<K extends keyof EggConfig>(key: K, value: EggConfig[K]) {
        if (!local) return;
        setLocal({ ...local, [key]: value });
        // Re-validate just this field so its message clears as soon as it's fixed.
        const message = (validateBboxConfig({ [key]: value }) as Record<string, string>)[key];
        setFieldErrors((prev) => {
            const { [key]: _removed, ...rest } = prev;
            return message ? { ...rest, [key]: message } : rest;
        });
    }

    async function handleSave() {
        if (!local) return;
        const errs = validateBboxConfig(local) as Record<string, string>;
        setFieldErrors(errs);
        if (Object.keys(errs).length > 0) return;
        if (await saveConfig(local)) {
            onSaved?.(local);
            onOpenChange(false);
        }
    }

    function handleReset() {
        setLocal(config ? { ...config } : null);
        setFieldErrors({});
    }

    const label = organismMeta(organism).label;
    const isDirty =
        local !== null && config !== null && JSON.stringify(local) !== JSON.stringify(config);

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent size="md">
                <SheetHeader>
                    <SheetTitle>{label} inference settings</SheetTitle>
                    <SheetDescription>
                        {local === null && !error
                            ? 'Loading configuration…'
                            : 'Adjust how images are analyzed. Changes apply to the next analysis run.'}
                    </SheetDescription>
                </SheetHeader>

                {local === null ? (
                    <SheetBody>
                        {error ? (
                            <div className="space-y-3">
                                <SettingsError message={error} />
                                <Button variant="outline" size="sm" onClick={loadConfig}>
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
                                        htmlFor="conf-threshold"
                                        label="Confidence threshold"
                                        tooltip={TOOLTIPS.confidence_threshold}
                                        error={fieldErrors.confidence_threshold}
                                    >
                                        <SliderField
                                            id="conf-threshold"
                                            min={0.01}
                                            max={1.0}
                                            step={0.05}
                                            value={local.confidence_threshold}
                                            onChange={(v) => updateField('confidence_threshold', v)}
                                            format={(v) => v.toFixed(2)}
                                            disabled={saving}
                                        />
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="min-box"
                                        label="Min box area"
                                        tooltip={TOOLTIPS.min_box_area}
                                        error={fieldErrors.min_box_area}
                                    >
                                        <NumberField
                                            id="min-box"
                                            value={local.min_box_area}
                                            onChange={(v) => updateField('min_box_area', v)}
                                            step={10}
                                            min={1}
                                            max={10000}
                                            suffix="px²"
                                            disabled={saving}
                                        />
                                    </LabeledField>
                                </SettingsGroup>

                                <SettingsGroup title="Deduplication">
                                    <LabeledField
                                        htmlFor="dedup-mode"
                                        label="Deduplication mode"
                                        tooltip={TOOLTIPS.dedup_mode}
                                        error={fieldErrors.dedup_mode}
                                        hint={
                                            local.dedup_mode === 'center_zone'
                                                ? 'Recommended — no duplicates by design.'
                                                : 'Legacy — global NMS may miss some duplicates.'
                                        }
                                    >
                                        <Select
                                            value={local.dedup_mode}
                                            onValueChange={(v) =>
                                                updateField(
                                                    'dedup_mode',
                                                    v as 'center_zone' | 'edge_nms',
                                                )
                                            }
                                            disabled={saving}
                                        >
                                            <SelectTrigger id="dedup-mode" className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="center_zone">
                                                    Center Zone (recommended)
                                                </SelectItem>
                                                <SelectItem value="edge_nms">
                                                    Edge NMS (legacy)
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </LabeledField>

                                    {local.dedup_mode === 'edge_nms' && (
                                        <div className="space-y-4 rounded-lg border border-border bg-muted/40 p-4">
                                            <p className="text-xs font-medium text-muted-foreground">
                                                Only applies when dedup mode is "Edge NMS"
                                            </p>

                                            <LabeledField
                                                htmlFor="edge-margin"
                                                label="Edge margin"
                                                tooltip={TOOLTIPS.edge_margin}
                                                error={fieldErrors.edge_margin}
                                            >
                                                <NumberField
                                                    id="edge-margin"
                                                    value={local.edge_margin}
                                                    onChange={(v) => updateField('edge_margin', v)}
                                                    step={1}
                                                    min={0}
                                                    max={50}
                                                    suffix="px"
                                                    disabled={saving}
                                                />
                                            </LabeledField>

                                            <LabeledField
                                                htmlFor="nms-iou"
                                                label="NMS IoU threshold"
                                                tooltip={TOOLTIPS.nms_iou_threshold}
                                                error={fieldErrors.nms_iou_threshold}
                                            >
                                                <SliderField
                                                    id="nms-iou"
                                                    min={0.05}
                                                    max={1.0}
                                                    step={0.05}
                                                    value={local.nms_iou_threshold}
                                                    onChange={(v) =>
                                                        updateField('nms_iou_threshold', v)
                                                    }
                                                    format={(v) => v.toFixed(2)}
                                                    disabled={saving}
                                                />
                                            </LabeledField>
                                        </div>
                                    )}
                                </SettingsGroup>

                                <SettingsGroup title="Tiling">
                                    <LabeledField
                                        htmlFor="tile-size"
                                        label="Tile size"
                                        tooltip={TOOLTIPS.tile_size}
                                        error={fieldErrors.tile_size}
                                    >
                                        <NumberField
                                            id="tile-size"
                                            value={local.tile_size}
                                            onChange={(v) => updateField('tile_size', v)}
                                            step={64}
                                            min={128}
                                            max={2048}
                                            suffix="px"
                                            disabled={saving}
                                        />
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="overlap"
                                        label="Tile overlap"
                                        tooltip={TOOLTIPS.overlap}
                                        error={fieldErrors.overlap}
                                    >
                                        <SliderField
                                            id="overlap"
                                            min={0.0}
                                            max={0.9}
                                            step={0.05}
                                            value={local.overlap}
                                            onChange={(v) => updateField('overlap', v)}
                                            format={(v) => `${Math.round(v * 100)}%`}
                                            disabled={saving}
                                        />
                                    </LabeledField>

                                    <LabeledField
                                        htmlFor="batch-size"
                                        label="Batch size"
                                        tooltip={TOOLTIPS.batch_size}
                                        error={fieldErrors.batch_size}
                                        hint="Higher values use more memory but process faster."
                                    >
                                        <NumberField
                                            id="batch-size"
                                            value={local.batch_size}
                                            onChange={(v) => updateField('batch_size', v)}
                                            step={1}
                                            min={1}
                                            max={64}
                                            disabled={saving}
                                        />
                                    </LabeledField>
                                </SettingsGroup>

                                {error && <SettingsError message={error} />}
                            </div>
                        </SheetBody>

                        <SheetFooter>
                            <Button
                                variant="secondary"
                                onClick={handleReset}
                                disabled={saving || !isDirty}
                                className="flex-1"
                            >
                                Reset
                            </Button>
                            <Button
                                onClick={handleSave}
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
