// StatTile — one headline number: label, value, optional unit, and an
// optional change against a named comparison period.

import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface StatDelta {
    /** Fractional change, e.g. 0.12 for +12%. `null` when there is no baseline. */
    change: number | null;
    /** Whether an increase is good news (false for durations, error counts…). */
    upIsGood?: boolean;
    /** What the change is measured against — "vs previous 30 days". */
    label: string;
}

interface StatTileProps {
    label: string;
    value: ReactNode;
    unit?: string;
    /** Secondary line under the value when there is no delta. */
    hint?: ReactNode;
    delta?: StatDelta;
    icon?: React.ElementType;
    loading?: boolean;
    className?: string;
}

export function StatTile({
    label,
    value,
    unit,
    hint,
    delta,
    icon: Icon,
    loading = false,
    className,
}: StatTileProps) {
    return (
        <div className={cn('panel flex min-w-0 flex-col gap-2 p-4', className)}>
            <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[13px] font-medium text-muted-foreground">{label}</p>
                {Icon && <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />}
            </div>
            {loading ? (
                <Skeleton className="h-8 w-24" />
            ) : (
                // Proportional figures: tabular digits look loose at this size.
                <p className="flex items-baseline gap-1 text-[28px] leading-8 font-semibold tracking-tight">
                    <span className="truncate">{value}</span>
                    {unit && (
                        <span className="text-sm font-medium text-muted-foreground">{unit}</span>
                    )}
                </p>
            )}
            {loading ? (
                <Skeleton className="h-4 w-32" />
            ) : delta ? (
                <DeltaLine delta={delta} />
            ) : hint ? (
                <p className="truncate text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

function DeltaLine({ delta }: { delta: StatDelta }) {
    const { change, upIsGood = true, label } = delta;
    if (change === null || !Number.isFinite(change)) {
        return <p className="truncate text-xs text-muted-foreground">No data {label}</p>;
    }
    const flat = Math.abs(change) < 0.0005;
    const up = change > 0;
    const good = flat ? null : up === upIsGood;
    const DirIcon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
    return (
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {/* Direction is carried by the arrow and the sign, not by colour alone. */}
            <span
                className={cn(
                    'inline-flex items-center gap-0.5 font-medium tabular-nums',
                    good === true && 'text-success',
                    good === false && 'text-destructive',
                )}
            >
                <DirIcon className="size-3.5" aria-hidden />
                {up ? '+' : ''}
                {(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%
            </span>
            <span className="truncate">{label}</span>
        </p>
    );
}
