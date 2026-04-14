// StatBoard — displays egg detection statistics for a single result.

import { Microscope, Clock, Image as ImageIcon, Settings } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AnimatedNumber } from "@/components/common/AnimatedNumber";
import type { DetectionResult } from "@/types/api";
import { cn } from "@/lib/utils";

interface StatBoardProps {
  result: DetectionResult;
  /** The config snapshot recorded when processing started */
  config?: Record<string, unknown> | null;
}

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

export function StatBoard({ result, config }: StatBoardProps) {
  const avgConf = result.avg_confidence;

  // Build the ordered list of config params to display.
  // These are the inference parameters that affect results.
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

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      {/* Egg count — primary metric */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Microscope className="h-4 w-4" />
            Egg Count
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-5xl font-bold">
            <AnimatedNumber value={result.count} className="tabular-nums" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.annotations.length} annotations
          </p>
        </CardContent>
      </Card>

      {/* Confidence */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Avg Confidence
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-baseline gap-2">
          <ConfidenceDot value={avgConf} />
          {/* Confidence bar */}
          <div className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                avgConf >= 0.7 ? "bg-green-500" : avgConf >= 0.5 ? "bg-yellow-500" : "bg-red-500",
              )}
              style={{ width: `${avgConf * 100}%` }}
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

      {/* Confidence breakdown */}
      {result.annotations.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Confidence Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {[
              { label: "≥ 90%", count: result.annotations.filter((a) => a.confidence >= 0.9).length },
              { label: "70–89%", count: result.annotations.filter((a) => a.confidence >= 0.7 && a.confidence < 0.9).length },
              { label: "50–69%", count: result.annotations.filter((a) => a.confidence >= 0.5 && a.confidence < 0.7).length },
              { label: "< 50%", count: result.annotations.filter((a) => a.confidence < 0.5).length },
            ].map(({ label, count }) => (
              <div key={label} className="flex items-center gap-3 text-sm">
                <span className="w-16 text-muted-foreground">{label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${result.annotations.length > 0 ? (count / result.annotations.length) * 100 : 0}%` }}
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
