// OrganismBadge / StatusBadge — the two chips that identify a batch.

import { AlertCircle, CheckCircle2, CircleDashed, FileEdit, Loader2 } from 'lucide-react';

import { organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';

export function OrganismBadge({ organism, className }: { organism: string; className?: string }) {
    const meta = organismMeta(organism);
    return (
        <span
            className={cn(
                'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-1.5 text-[11px] font-medium text-foreground',
                className,
            )}
        >
            {/* The dot carries the organism's chart colour; the text stays in ink. */}
            <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ backgroundColor: meta.color }}
            />
            {meta.label}
        </span>
    );
}

type BatchStatus = 'completed' | 'draft' | 'processing' | 'failed';

const STATUS: Record<
    BatchStatus,
    { label: string; icon: React.ElementType; className: string; title: string }
> = {
    completed: {
        label: 'Saved',
        icon: CheckCircle2,
        className: 'border-success/25 bg-success/10 text-success',
        title: 'Reviewed and saved to Records',
    },
    draft: {
        label: 'Draft',
        icon: FileEdit,
        className: 'border-warning/30 bg-warning/10 text-warning',
        title: 'Processed — waiting for review',
    },
    processing: {
        label: 'Processing',
        icon: Loader2,
        className: 'border-info/25 bg-info/10 text-info',
        title: 'Inference is running',
    },
    failed: {
        label: 'Failed',
        icon: AlertCircle,
        className: 'border-destructive/25 bg-destructive/10 text-destructive',
        title: 'Processing did not finish',
    },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
    const info = STATUS[status as BatchStatus];
    if (!info) {
        return (
            <span
                className={cn(
                    'inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 text-[11px] font-medium text-muted-foreground capitalize',
                    className,
                )}
            >
                <CircleDashed className="size-3" aria-hidden />
                {status}
            </span>
        );
    }
    const Icon = info.icon;
    return (
        <span
            title={info.title}
            className={cn(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium',
                info.className,
                className,
            )}
        >
            <Icon className={cn('size-3', status === 'processing' && 'animate-spin')} aria-hidden />
            {info.label}
        </span>
    );
}
