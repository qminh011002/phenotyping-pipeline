// LarvaeCalibrationBanner — shown when the image has no usable scale, with
// the three ways to get one (FE-034). Counting does not need a scale, so
// this reads as "needed for measuring", not as an error.

import { CircleAlert, Pencil, RefreshCcw, Ruler, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { CalibrationCorners } from '@/types/api';

interface LarvaeCalibrationBannerProps {
    calibration: CalibrationCorners | null;
    onEditCorners?: () => void;
    onEditManual?: () => void;
    onRedetect?: () => void;
    redetecting?: boolean;
    className?: string;
}

export function LarvaeCalibrationBanner({
    calibration,
    onEditCorners,
    onEditManual,
    onRedetect,
    redetecting = false,
    className,
}: LarvaeCalibrationBannerProps) {
    const status = calibration?.detection_status ?? null;
    const hasCorners = Boolean(calibration?.auto_corners) || Boolean(calibration?.edited_corners);

    // Detected / manual — banner is hidden. Both states mean calibration is
    // good enough to run measurements; the toolbar's ruler tool and the
    // Details tab already surface Drag corners / Re-detect.
    if (calibration && status !== 'failed') return null;

    const Icon = calibration ? CircleAlert : Search;

    return (
        <div
            role="alert"
            data-testid="larvae-calibration-banner"
            className={cn(
                'rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm',
                className,
            )}
        >
            <div className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <div className="min-w-0">
                    <p className="font-medium text-foreground">
                        {calibration ? 'Calibration failed' : 'No calibration yet'}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {calibration
                            ? "We couldn't find the green calibration rectangle. The count is unaffected — set the scale to measure sizes."
                            : 'The count is unaffected. Detect the calibration rectangle or set the scale by hand to measure sizes.'}
                    </p>
                </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
                {onRedetect && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={onRedetect}
                        disabled={redetecting}
                    >
                        <RefreshCcw className={cn(redetecting && 'animate-spin')} />
                        {calibration ? 'Re-detect' : 'Detect'}
                    </Button>
                )}
                {onEditCorners && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={onEditCorners}
                        disabled={!hasCorners}
                        title={
                            hasCorners
                                ? 'Drag the four corners onto the calibration rectangle'
                                : 'No corners to start from — use Manual scale'
                        }
                    >
                        <Pencil />
                        Drag corners
                    </Button>
                )}
                {onEditManual && (
                    <Button size="sm" variant="outline" className="h-7" onClick={onEditManual}>
                        <Ruler />
                        Manual scale
                    </Button>
                )}
            </div>
        </div>
    );
}
