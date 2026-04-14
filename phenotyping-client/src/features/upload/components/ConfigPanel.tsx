// ConfigPanel — inference settings sheet with tooltips, validation, and live preview.
//
// Displays and edits egg detection parameters sourced from GET /config and persisted
// via PUT /config. Designed as a shadcn Sheet panel that opens from the upload page.

import { useState, useEffect } from "react";
import { Info } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/features/upload/hooks/useConfig";
import type { EggConfig } from "@/types/api";

// ── Parameter tooltip content (from infer_egg_doc.md) ──────────────────────────

const TOOLTIPS: Record<string, string> = {
  confidence_threshold:
    "Minimum confidence score for a detection to be counted. Lower values detect more objects but may include false positives.",
  dedup_mode:
    'How to handle overlapping tile detections:\n• "Center Zone" (recommended): keeps detection only if its center falls in a tile\'s valid zone — O(N), no duplicates by design.\n• "Edge NMS": skips edge-touching boxes then applies global NMS as a safety net — O(N²), legacy approach.',
  tile_size:
    "Size of each square tile in pixels. Images are split into overlapping tiles for inference. Larger tiles cover more area but require more memory.",
  overlap:
    "Overlap ratio between adjacent tiles (0.0–0.9). Higher overlap improves detection near tile boundaries but increases computation. 0.5 recommended for center_zone.",
  min_box_area:
    "Filter out bounding boxes smaller than this area in pixels². Helps remove spurious tiny detections.",
  batch_size:
    "Number of tiles processed in parallel per inference batch. Higher values are faster but use more memory.",
  edge_margin:
    "Skip detections whose bounding box is within this many pixels of a tile edge. Only applies when dedup_mode is 'edge_nms'.",
  nms_iou_threshold:
    "IoU threshold for global NMS (deduplication pass). Only applies when dedup_mode is 'edge_nms'. Higher values are more aggressive at merging overlapping boxes.",
};

// ── Label with tooltip ─────────────────────────────────────────────────────────

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
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Field: number input ───────────────────────────────────────────────────────

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

// ── ConfigPanel ────────────────────────────────────────────────────────────────

interface ConfigPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (config: EggConfig) => void;
}

export function ConfigPanel({ open, onOpenChange, onSaved }: ConfigPanelProps) {
  const { config, saving, error, validationErrors, isDirty, saveConfig, resetConfig } =
    useConfig();

  // Local copy of config for the form
  const [local, setLocal] = useState<EggConfig | null>(null);

  // Sync local when config loads
  useEffect(() => {
    if (config) setLocal(config);
  }, [config]);

  function updateField<K extends keyof EggConfig>(key: K, value: EggConfig[K]) {
    if (!local) return;
    const next = { ...local, [key]: value };
    setLocal(next);
    // Validate this field
    const errs = validateSingle(key, value);
    if (Object.keys(errs).length === 0) {
      // Clear field error if fixed
      setFieldError(key, undefined);
    }
  }

  // Field-level error state (mirrors validationErrors but reset per-field)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function setFieldError(key: string, msg: string | undefined) {
    setFieldErrors((prev) => {
      if (msg === undefined) {
        const { [key]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: msg };
    });
  }

  function validateSingle(key: string, value: unknown): Record<string, string> {
    if (key === "tile_size") {
      const v = value as number;
      if (!Number.isInteger(v) || v < 128 || v > 2048)
        return { tile_size: "Must be an integer between 128 and 2048" };
    }
    if (key === "overlap") {
      const v = value as number;
      if (v < 0 || v > 0.9) return { overlap: "Must be between 0.0 and 0.9" };
    }
    if (key === "confidence_threshold") {
      const v = value as number;
      if (v < 0.01 || v > 1.0) return { confidence_threshold: "Must be between 0.01 and 1.0" };
    }
    if (key === "min_box_area") {
      const v = value as number;
      if (!Number.isInteger(v) || v < 1) return { min_box_area: "Must be a positive integer" };
    }
    if (key === "edge_margin") {
      const v = value as number;
      if (!Number.isInteger(v) || v < 0) return { edge_margin: "Must be a non-negative integer" };
    }
    if (key === "nms_iou_threshold") {
      const v = value as number;
      if (v < 0.05 || v > 1.0) return { nms_iou_threshold: "Must be between 0.05 and 1.0" };
    }
    if (key === "batch_size") {
      const v = value as number;
      if (!Number.isInteger(v) || v < 1 || v > 64)
        return { batch_size: "Must be an integer between 1 and 64" };
    }
    return {};
  }

  async function handleSave() {
    if (!local) return;
    const errs: Record<string, string> = {};
    const fields: (keyof EggConfig)[] = [
      "tile_size", "overlap", "confidence_threshold",
      "min_box_area", "edge_margin", "nms_iou_threshold", "batch_size",
    ];
    for (const field of fields) {
      const e = validateSingle(field, local[field]);
      Object.assign(errs, e);
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const ok = await saveConfig(local);
    if (ok) {
      onSaved?.(local);
      onOpenChange(false);
    }
  }

  function handleReset() {
    resetConfig();
    setLocal(config ? { ...config } : null);
    setFieldErrors({});
  }

  if (local === null) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent size="md">
          <SheetHeader>
            <SheetTitle>Inference Settings</SheetTitle>
            <SheetDescription>Loading configuration…</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div className="flex flex-1 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    );
  }

  const showEdgeNmsFields = local.dedup_mode === "edge_nms";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Inference Settings</SheetTitle>
          <SheetDescription>
            Adjust how images are analyzed. Changes apply to the next analysis run.
          </SheetDescription>
        </SheetHeader>

        <TooltipProvider delayDuration={300}>
          <SheetBody>
            <div className="flex flex-col gap-5">

            {/* Confidence Threshold */}
            <LabeledField
              htmlFor="conf-threshold"
              label="Confidence Threshold"
              tooltip={TOOLTIPS.confidence_threshold}
              error={validationErrors.confidence_threshold ?? fieldErrors.confidence_threshold}
            >
              <div className="flex items-center gap-3">
                <Slider
                  id="conf-threshold"
                  min={0.01} max={1.0} step={0.05}
                  value={[local.confidence_threshold]}
                  onValueChange={([v]) => updateField("confidence_threshold", v)}
                  disabled={saving}
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono text-sm tabular-nums">
                  {local.confidence_threshold.toFixed(2)}
                </span>
              </div>
            </LabeledField>

            {/* Dedup Mode */}
            <LabeledField
              htmlFor="dedup-mode"
              label="Deduplication Mode"
              tooltip={TOOLTIPS.dedup_mode}
              error={fieldErrors.dedup_mode}
              hint={
                local.dedup_mode === "center_zone"
                  ? "Recommended — no duplicates by design."
                  : "Legacy — global NMS may miss some duplicates."
              }
            >
              <Select
                value={local.dedup_mode}
                onValueChange={(v) => updateField("dedup_mode", v as "center_zone" | "edge_nms")}
                disabled={saving}
              >
                <SelectTrigger id="dedup-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="center_zone">Center Zone (recommended)</SelectItem>
                  <SelectItem value="edge_nms">Edge NMS (legacy)</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>

            {/* Edge NMS params — conditional */}
            {showEdgeNmsFields && (
              <div className="space-y-4 rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">
                  Only applies when dedup mode is "Edge NMS"
                </p>

                <LabeledField
                  htmlFor="edge-margin"
                  label="Edge Margin"
                  tooltip={TOOLTIPS.edge_margin}
                  error={validationErrors.edge_margin ?? fieldErrors.edge_margin}
                >
                  <NumberField
                    id="edge-margin"
                    value={local.edge_margin}
                    onChange={(v) => updateField("edge_margin", v)}
                    step={1}
                    min={0}
                    max={50}
                    suffix="px"
                  />
                </LabeledField>

                <LabeledField
                  htmlFor="nms-iou"
                  label="NMS IoU Threshold"
                  tooltip={TOOLTIPS.nms_iou_threshold}
                  error={validationErrors.nms_iou_threshold ?? fieldErrors.nms_iou_threshold}
                >
                  <div className="flex items-center gap-3">
                    <Slider
                      id="nms-iou"
                      min={0.05} max={1.0} step={0.05}
                      value={[local.nms_iou_threshold]}
                      onValueChange={([v]) => updateField("nms_iou_threshold", v)}
                      disabled={saving}
                      className="flex-1"
                    />
                    <span className="w-12 text-right font-mono text-sm tabular-nums">
                      {local.nms_iou_threshold.toFixed(2)}
                    </span>
                  </div>
                </LabeledField>
              </div>
            )}

            {/* Tile Size */}
            <LabeledField
              htmlFor="tile-size"
              label="Tile Size"
              tooltip={TOOLTIPS.tile_size}
              error={validationErrors.tile_size ?? fieldErrors.tile_size}
            >
              <NumberField
                id="tile-size"
                value={local.tile_size}
                onChange={(v) => updateField("tile_size", v)}
                step={64}
                min={128}
                max={2048}
                suffix="px"
              />
            </LabeledField>

            {/* Overlap */}
            <LabeledField
              htmlFor="overlap"
              label="Tile Overlap"
              tooltip={TOOLTIPS.overlap}
              error={validationErrors.overlap ?? fieldErrors.overlap}
            >
              <div className="flex items-center gap-3">
                <Slider
                  id="overlap"
                  min={0.0} max={0.9} step={0.05}
                  value={[local.overlap]}
                  onValueChange={([v]) => updateField("overlap", v)}
                  disabled={saving}
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono text-sm tabular-nums">
                  {Math.round(local.overlap * 100)}%
                </span>
              </div>
            </LabeledField>

            {/* Min Box Area */}
            <LabeledField
              htmlFor="min-box"
              label="Min Box Area"
              tooltip={TOOLTIPS.min_box_area}
              error={validationErrors.min_box_area ?? fieldErrors.min_box_area}
            >
              <NumberField
                id="min-box"
                value={local.min_box_area}
                onChange={(v) => updateField("min_box_area", v)}
                step={10}
                min={1}
                max={10000}
                suffix="px²"
              />
            </LabeledField>

            {/* Batch Size */}
            <LabeledField
              htmlFor="batch-size"
              label="Batch Size"
              tooltip={TOOLTIPS.batch_size}
              error={validationErrors.batch_size ?? fieldErrors.batch_size}
              hint="Higher values use more memory but process faster."
            >
              <NumberField
                id="batch-size"
                value={local.batch_size}
                onChange={(v) => updateField("batch_size", v)}
                step={1}
                min={1}
                max={64}
              />
            </LabeledField>
          </div>

          {/* Error banner */}
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </div>
          )}
        </SheetBody>

        {/* Actions */}
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
            onClick={handleSave}
            disabled={saving || Object.keys(validationErrors).length > 0 || Object.keys(fieldErrors).length > 0}
            className="flex-1"
          >
            {saving ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                Saving…
              </>
            ) : (
              "Apply"
            )}
          </Button>
        </SheetFooter>
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}