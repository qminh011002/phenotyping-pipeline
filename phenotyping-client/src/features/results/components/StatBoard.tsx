// StatBoard — displays egg detection statistics for a single result.
// The confidence slider lives here too: moving it updates both the displayed
// Egg Count and the boxes rendered by OverlayImage.

import { useMemo } from "react";
import { Microscope, Clock, Image as ImageIcon, Settings, SlidersHorizontal } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { AnimatedNumber } from "@/components/common/AnimatedNumber";
import type { BBox, DetectionResult } from "@/types/api";
import { cn } from "@/lib/utils";

interface StatBoardProps {
  result: DetectionResult;
  /** The config snapshot recorded when processing started */
  config?: Record<string, unknown> | null;
  /** Annotations currently visible (filtered by confidenceThreshold) */
  visibleAnnotations: BBox[];
  confidenceThreshold: number;
  onConfidenceChange: (value: number) => void;
  /** FS-009: editor is active */
  editMode?: boolean;
  /** FS-009: original model boxes (for computing added/removed/modified) */
  modelBoxes?: BBox[];
  /** FS-009: current session boxes (for computing added/removed/modified) */
  sessionBoxes?: BBox[];
}

const PRESETS: number[] = [0, 0.5, 0.7, 0.9];

const CONFIG_KEYS: Array<[string, string]> = [
  ["confidence_threshold", "Confidence threshold"],
  ["tile_size", "Tile size"],
  ["overlap", "Overlap"],
  ["dedup_mode", "Dedup mode"],
  ["min_box_area", "Min box area"],
  ["edge_margin", "Edge margin"],
  ["nms_iou_threshold", "NMS IoU"],
  ["batch_size", "Batch size"],
];


function ConfidenceDot({ value }: { value: number }) {
  const color =
    value >= 0.7 ? "text-green-600 dark:text-green-400" :
    value >= 0.5 ? "text-yellow-600 dark:text-yellow-400" :
    "text-red-600 dark:text-red-400";
  return <span className={cn("font-mono font-medium", color)}>{value >= 0 ? `${(value * 100).toFixed(1)}%` : "—"}</span>;
}

function StatRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

export function StatBoard({
  result,
  config,
  visibleAnnotations,
  confidenceThreshold,
  onConfidenceChange,
  editMode: _editMode = false,
  modelBoxes = [],
  sessionBoxes = [],
}: StatBoardProps) {
  const totalCount = result.annotations.length;
  const visibleCount = visibleAnnotations.length;
  const avgConfVisible = useMemo(
    () =>
      visibleCount > 0
        ? visibleAnnotations.reduce((s, a) => s + a.confidence, 0) / visibleCount
        : 0,
    [visibleAnnotations, visibleCount],
  );

  // Edit counts (modelBoxes vs sessionBoxes) are intentionally not displayed yet —
  // the calculation is preserved for the upcoming edit-summary card.
  void modelBoxes;
  void sessionBoxes;

  // Single-pass confidence breakdown.
  const breakdown = useMemo(() => {
    let ge90 = 0;
    let ge70 = 0;
    let ge50 = 0;
    let lt50 = 0;
    for (const a of result.annotations) {
      const c = a.confidence;
      if (c >= 0.9) ge90 += 1;
      else if (c >= 0.7) ge70 += 1;
      else if (c >= 0.5) ge50 += 1;
      else lt50 += 1;
    }
    return [
      { label: "≥ 90%", count: ge90 },
      { label: "70–89%", count: ge70 },
      { label: "50–69%", count: ge50 },
      { label: "< 50%", count: lt50 },
    ];
  }, [result.annotations]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {/* Egg count — reflects the current filter */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Microscope className="h-4 w-4" />
            Egg Count
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <div className="text-5xl font-bold">
              <AnimatedNumber value={visibleCount} className="tabular-nums" />
            </div>
            {visibleCount !== totalCount && (
              <span className="font-mono text-sm text-muted-foreground">
                / {totalCount}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {confidenceThreshold > 0
              ? `filtered at ≥${(confidenceThreshold * 100).toFixed(0)}% confidence`
              : `${totalCount} total detections`}
          </p>
        </CardContent>
      </Card>

    

      {/* Confidence Threshold — slider + presets in one card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            Confidence Threshold
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Minimum confidence</span>
              <span className="font-mono text-sm font-semibold tabular-nums">
                {(confidenceThreshold * 100).toFixed(0)}%
              </span>
            </div>
            <Slider
              value={[confidenceThreshold]}
              onValueChange={(v) => onConfidenceChange(v[0] ?? 0)}
              min={0}
              max={1}
              step={0.01}
            />
          </div>

          <div className="grid grid-cols-4 gap-2">
            {PRESETS.map((v) => (
              <Button
                key={v}
                variant={Math.abs(confidenceThreshold - v) < 1e-6 ? "default" : "outline"}
                size="sm"
                onClick={() => onConfidenceChange(v)}
                className="font-mono text-xs"
              >
                {v === 0 ? "All" : `≥${Math.round(v * 100)}%`}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Avg confidence of visible detections */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Avg Confidence
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-baseline gap-2">
          <ConfidenceDot value={avgConfVisible} />
          <div className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                avgConfVisible >= 0.7 ? "bg-green-500" : avgConfVisible >= 0.5 ? "bg-yellow-500" : "bg-red-500",
              )}
              style={{ width: `${avgConfVisible * 100}%` }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Processing details */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-0 p-0 px-4">
          <StatRow
            icon={Clock}
            label="Processing time"
            value={
              <span className="font-mono text-sm">
                {result.elapsed_seconds >= 0 ? `${result.elapsed_seconds.toFixed(2)}s` : "—"}
              </span>
            }
          />
          <Separator />
          <StatRow
            icon={ImageIcon}
            label="Organism"
            value={<Badge variant="secondary">{result.organism}</Badge>}
          />
        </CardContent>
      </Card>

      {/* Filename */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            File
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="truncate text-sm font-mono" title={result.filename}>
            {result.filename}
          </p>
        </CardContent>
      </Card>

      {/* Confidence breakdown — based on total annotations */}
      {totalCount > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Confidence Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {breakdown.map(({ label, count }) => (
              <div key={label} className="flex items-center gap-3 text-sm">
                <span className="w-16 text-muted-foreground">{label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${totalCount > 0 ? (count / totalCount) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-6 text-right font-mono text-xs">{count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Config parameters */}
      {config && Object.keys(config).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Config Used
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 p-4">
            {CONFIG_KEYS.map(([key, label]) => {
              const val = config[key];
              if (val === undefined || val === null) return null;
              return (
                <div key={key} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono font-medium">
                    {typeof val === "number" && key.includes("threshold") || key === "overlap" || key === "nms_iou_threshold"
                      ? (Number(val) * 100).toFixed(1) + "%"
                      : String(val)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
