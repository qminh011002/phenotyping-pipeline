// LarvaeCalibrationBanner — status banner + edit/re-detect actions (FE-034).

import { AlertCircle, Hand, Pencil, RefreshCcw, Search } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
    const hasAutoCorners = Boolean(calibration?.auto_corners);

    const Actions = (
        <div className="mt-2 flex flex-wrap gap-2">
            {onEditCorners && (
                <Button
                    size="sm"
                    variant="outline"
                    onClick={onEditCorners}
                    disabled={!hasAutoCorners && !calibration?.edited_corners}
                >
                    <Pencil className="mr-1 h-3 w-3" />
                    Drag corners
                </Button>
            )}
            {onEditManual && (
                <Button size="sm" variant="outline" onClick={onEditManual}>
                    Manual scale
                </Button>
            )}
            {onRedetect && (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={onRedetect}
                    disabled={redetecting}
                >
                    <RefreshCcw
                        className={cn(
                            'mr-1 h-3 w-3',
                            redetecting && 'animate-spin',
                        )}
                    />
                    Re-detect
                </Button>
            )}
        </div>
    );

    if (!calibration || status === 'failed') {
        return (
            <Alert
                variant="destructive"
                className={cn(className)}
                data-testid="larvae-calibration-banner"
            >
                {calibration ? (
                    <AlertCircle className="h-4 w-4" />
                ) : (
                    <Search className="h-4 w-4" />
                )}
                <AlertTitle>
                    {calibration ? 'Calibration failed' : 'No calibration yet'}
                </AlertTitle>
                <AlertDescription>
                    {calibration
                        ? "We couldn't auto-detect the green calibration rectangle. Set the corners manually to enable measurements."
                        : 'Run calibration detection or set the corners manually before measurements can be computed.'}
                    {Actions}
                </AlertDescription>
            </Alert>
        );
    }

    if (status === 'manual') {
        return (
            <Alert className={cn(className)} data-testid="larvae-calibration-banner">
                <Hand className="h-4 w-4" />
                <AlertTitle>Manual calibration</AlertTitle>
                <AlertDescription>
                    Calibration corners were set manually.
                    {Actions}
                </AlertDescription>
            </Alert>
        );
    }

    // Detected — banner is hidden; the toolbar's ruler tool and chrome already
    // surface Drag corners / Re-detect, so a redundant card on the right is
    // just visual noise.
    return null;
}
