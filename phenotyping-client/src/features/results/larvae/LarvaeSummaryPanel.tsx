// LarvaeSummaryPanel — count, mean length, mean area, calibration status badge.
//
// Lightweight read-only summary that lives in the result viewer's side panel
// alongside the measurement table.

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

import { downloadLarvaeCsv } from '@/services/api';

import type {
    CalibrationCorners,
    LarvaeMeasurement,
    StoredLarvaeAnnotation,
} from '@/types/api';

interface LarvaeSummaryPanelProps {
    batchId: string;
    batchName: string;
    detections: StoredLarvaeAnnotation[];
    measurements: LarvaeMeasurement[];
    calibration: CalibrationCorners | null;
}

function mean(values: Array<number | null | undefined>): number | null {
    const xs = values.filter((v): v is number => typeof v === 'number');
    if (xs.length === 0) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n: number | null, digits = 2): string {
    if (n == null) return '—';
    return n.toFixed(digits);
}

export function LarvaeSummaryPanel({
    batchId,
    batchName,
    detections,
    measurements,
    calibration,
}: LarvaeSummaryPanelProps) {
    const [downloading, setDownloading] = useState(false);
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
            // Defer revoke so the browser has time to start the download.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'CSV download failed');
        } finally {
            setDownloading(false);
        }
    }

    const statusVariant = (() => {
        if (!calibration) return 'destructive' as const;
        if (calibration.detection_status === 'detected') return 'default' as const;
        if (calibration.detection_status === 'manual') return 'secondary' as const;
        return 'destructive' as const;
    })();
    const statusLabel = calibration?.detection_status ?? 'missing';

    return (
        <div className="space-y-4 p-4" data-testid="larvae-summary-panel">
            <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Larvae detected
                </p>
                <p className="text-3xl font-semibold tabular-nums">{detections.length}</p>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                    <dt className="text-xs text-muted-foreground">Mean length</dt>
                    <dd className="tabular-nums">{fmt(meanLength)} mm</dd>
                </div>
                <div>
                    <dt className="text-xs text-muted-foreground">Mean max width</dt>
                    <dd className="tabular-nums">{fmt(meanMaxWidth)} mm</dd>
                </div>
                <div>
                    <dt className="text-xs text-muted-foreground">Mean area</dt>
                    <dd className="tabular-nums">{fmt(meanArea)} mm²</dd>
                </div>
            </dl>
            <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Calibration</span>
                <Badge variant={statusVariant}>{statusLabel}</Badge>
            </div>
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
