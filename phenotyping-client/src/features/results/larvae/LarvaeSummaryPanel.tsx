// LarvaeSummaryPanel — the count for the image on screen, plus the two facts
// that decide how far the numbers can be trusted: where the outlines came
// from and whether the scale is known.

import { CheckCircle2, CircleAlert, CircleDashed, Sparkles } from 'lucide-react';

import { AnimatedNumber } from '@/components/common/AnimatedNumber';
import { organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';

import type { CalibrationCorners, Organism } from '@/types/api';

import { calibrationUsable } from './measureFlow';

interface LarvaeSummaryPanelProps {
    organism: Organism;
    /** Detections on the image right now, unsaved edits included. */
    count: number;
    /** How many of them were drawn by hand. */
    userDrawnCount: number;
    calibration: CalibrationCorners | null;
    samRefined: boolean;
    /** Image is still loading — show a placeholder instead of 0. */
    loading?: boolean;
}

function Chip({
    tone,
    icon: Icon,
    children,
    title,
}: {
    tone: 'good' | 'warn' | 'neutral';
    icon: React.ElementType;
    children: React.ReactNode;
    title: string;
}) {
    return (
        <span
            title={title}
            className={cn(
                'inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium',
                tone === 'good' && 'border-success/25 bg-success/10 text-success',
                tone === 'warn' && 'border-warning/30 bg-warning/10 text-warning',
                tone === 'neutral' && 'border-border bg-muted text-muted-foreground',
            )}
        >
            <Icon className="size-3" aria-hidden />
            {children}
        </span>
    );
}

export function LarvaeSummaryPanel({
    organism,
    count,
    userDrawnCount,
    calibration,
    samRefined,
    loading = false,
}: LarvaeSummaryPanelProps) {
    const meta = organismMeta(organism);
    const status = calibration?.detection_status ?? null;
    const scaleOk = calibrationUsable(calibration);

    return (
        <section className="px-4 pt-4 pb-3" data-testid="larvae-summary-panel">
            <p className="eyebrow">{meta.label} counted</p>
            <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-4xl leading-none font-semibold tracking-tight tabular-nums">
                    {loading ? '—' : <AnimatedNumber value={count} className="tabular-nums" />}
                </span>
                <span className="text-sm text-muted-foreground">
                    {count === 1 ? meta.noun : meta.nounPlural}
                    {userDrawnCount > 0 && ` · ${userDrawnCount} drawn by hand`}
                </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
                {scaleOk ? (
                    <Chip
                        tone="good"
                        icon={CheckCircle2}
                        title={
                            status === 'manual'
                                ? 'Scale was entered by hand'
                                : 'Calibration rectangle found automatically'
                        }
                    >
                        {status === 'manual' ? 'Scale set by hand' : 'Scale detected'}
                    </Chip>
                ) : (
                    <Chip
                        tone={calibration ? 'warn' : 'neutral'}
                        icon={calibration ? CircleAlert : CircleDashed}
                        title="Counting works without a scale; measuring needs one"
                    >
                        {calibration ? 'No scale found' : 'Scale not checked'}
                    </Chip>
                )}
                <Chip
                    tone="neutral"
                    icon={Sparkles}
                    title={
                        samRefined
                            ? 'Outlines were tightened with SAM'
                            : 'Outlines come straight from the detector — good for counting, a little loose for measuring'
                    }
                >
                    {samRefined ? 'SAM-refined outlines' : 'Detector outlines'}
                </Chip>
            </div>
        </section>
    );
}
