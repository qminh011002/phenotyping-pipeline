// LarvaeSummaryPanel — count, mean length/width/area, calibration status,
// per-image total-weight input, and batch-level weight stats.

import { Download, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

import { downloadLarvaeCsv, setImageTotalWeight } from '@/services/api';

import type {
    CalibrationCorners,
    LarvaeMeasurement,
    StoredLarvaeAnnotation,
    WeightStats,
} from '@/types/api';

interface LarvaeSummaryPanelProps {
    batchId: string;
    batchName: string;
    imageId: string;
    totalWeightMg: number | null;
    detections: StoredLarvaeAnnotation[];
    measurements: LarvaeMeasurement[];
    calibration: CalibrationCorners | null;
    weightStats: WeightStats | null;
    onWeightSaved: () => void;
}

function mean(values: Array<number | null | undefined>): number | null {
    const xs = values.filter((v): v is number => typeof v === 'number');
    if (xs.length === 0) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n: number | null | undefined, digits = 2): string {
    if (n == null) return '—';
    return n.toFixed(digits);
}

export function LarvaeSummaryPanel({
    batchId,
    batchName,
    imageId,
    totalWeightMg,
    detections,
    measurements,
    calibration,
    weightStats,
    onWeightSaved,
}: LarvaeSummaryPanelProps) {
    const [downloading, setDownloading] = useState(false);
    const [weightInput, setWeightInput] = useState<string>(
        totalWeightMg != null ? String(totalWeightMg) : '',
    );
    const [savingWeight, setSavingWeight] = useState(false);

    // Sync local input when navigating between images.
    useEffect(() => {
        setWeightInput(totalWeightMg != null ? String(totalWeightMg) : '');
    }, [imageId, totalWeightMg]);

    const meanLength = mean(measurements.map((m) => m.length_mm));
    const meanMaxWidth = mean(measurements.map((m) => m.max_width_mm));
    const meanArea = mean(measurements.map((m) => m.area_mm2));

    async function handleDownloadCsv() {
        setDownloading(true);
        try {
            const { blob, filename } = await downloadLarvaeCsv(batchId, batchName);
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
            setDownloading(false);
        }
    }

    async function handleSaveWeight() {
        const trimmed = weightInput.trim();
        let payloadValue: number | null = null;
        if (trimmed !== '') {
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed) || parsed < 0) {
                toast.error('Total weight must be a non-negative number.');
                return;
            }
            payloadValue = parsed;
        }
        setSavingWeight(true);
        try {
            await setImageTotalWeight(imageId, { total_weight_mg: payloadValue });
            onWeightSaved();
            toast.success(
                payloadValue == null
                    ? 'Cleared total weight for this image.'
                    : 'Total weight saved.',
            );
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed');
        } finally {
            setSavingWeight(false);
        }
    }

    const statusVariant = (() => {
        if (!calibration) return 'destructive' as const;
        if (calibration.detection_status === 'detected') return 'default' as const;
        if (calibration.detection_status === 'manual') return 'secondary' as const;
        return 'destructive' as const;
    })();
    const statusLabel = calibration?.detection_status ?? 'missing';

    const weightInputDirty =
        weightInput.trim() !== (totalWeightMg != null ? String(totalWeightMg) : '');

    return (
        <div
            className="space-y-4 border-b border-border p-4"
            data-testid="larvae-summary-panel"
        >
            <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Larvae detected
                    </p>
                    <p className="mt-1 text-3xl font-semibold leading-none tracking-tight tabular-nums">
                        {detections.length}
                    </p>
                </div>
                <Badge
                    variant={statusVariant}
                    className="h-5 shrink-0 gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider"
                >
                    {statusLabel}
                </Badge>
            </div>

            <dl className="grid grid-cols-3 gap-2">
                <Metric label="Length" value={fmt(meanLength)} unit="mm" />
                <Metric label="Width" value={fmt(meanMaxWidth)} unit="mm" />
                <Metric label="Area" value={fmt(meanArea)} unit="mm²" />
            </dl>

            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                <label
                    htmlFor="larvae-total-weight"
                    className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                    Total weight (mg) for this image
                </label>
                <div className="flex gap-2">
                    <Input
                        id="larvae-total-weight"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="—"
                        value={weightInput}
                        onChange={(e) => setWeightInput(e.target.value)}
                        disabled={savingWeight}
                        className="h-8 text-sm"
                    />
                    <Button
                        size="sm"
                        onClick={handleSaveWeight}
                        disabled={savingWeight || !weightInputDirty}
                    >
                        {savingWeight && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                        Save
                    </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                    Distributed across detections proportionally to area. Leave blank to clear.
                </p>
            </div>

            {weightStats && weightStats.count > 0 && (
                <div className="space-y-2 rounded-md border border-border bg-background p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Batch weight stats ({weightStats.count})
                    </p>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        <StatRow label="Total biomass" value={fmt(weightStats.total_biomass_mg)} unit="mg" />
                        <StatRow label="Mean" value={fmt(weightStats.mean)} unit="mg" />
                        <StatRow label="Median" value={fmt(weightStats.median)} unit="mg" />
                        <StatRow label="Std" value={fmt(weightStats.std)} unit="mg" />
                        <StatRow label="CV" value={fmt(weightStats.cv, 3)} unit="" />
                        <StatRow label="Min / Max" value={`${fmt(weightStats.min)} / ${fmt(weightStats.max)}`} unit="mg" />
                        <StatRow label="P5 / P95" value={`${fmt(weightStats.p5)} / ${fmt(weightStats.p95)}`} unit="mg" />
                        <StatRow label="IQR (P25–P75)" value={`${fmt(weightStats.p25)}–${fmt(weightStats.p75)}`} unit="mg" />
                        <StatRow label="Skew" value={fmt(weightStats.skewness, 3)} unit="" />
                        <StatRow label="Kurtosis" value={fmt(weightStats.kurtosis, 3)} unit="" />
                        <StatRow label="Avg W/A" value={fmt(weightStats.avg_weight_area_ratio, 3)} unit="" />
                    </dl>
                </div>
            )}

            <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleDownloadCsv}
                disabled={downloading}
            >
                {downloading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                    <Download className="mr-2 h-4 w-4" />
                )}
                Download CSV
            </Button>
        </div>
    );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
    return (
        <div className="rounded-md bg-muted/40 px-2.5 py-2">
            <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
            </dt>
            <dd className="mt-0.5 flex items-baseline gap-1 tabular-nums">
                <span className="text-sm font-semibold text-foreground">{value}</span>
                <span className="text-[10px] text-muted-foreground">{unit}</span>
            </dd>
        </div>
    );
}

function StatRow({ label, value, unit }: { label: string; value: string; unit: string }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">
                <span className="font-medium">{value}</span>
                {unit && <span className="ml-1 text-[10px] text-muted-foreground">{unit}</span>}
            </dd>
        </>
    );
}
