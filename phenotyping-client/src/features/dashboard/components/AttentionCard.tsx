// Outstanding work, across all time: what the operator still has to review,
// calibrate or measure.

import { Link } from 'react-router-dom';
import {
    AlertCircle,
    ArrowRight,
    CheckCircle2,
    FileEdit,
    Gauge,
    Ruler,
    ScanLine,
} from 'lucide-react';

import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DashboardAttention } from '@/types/api';

interface Item {
    key: keyof DashboardAttention;
    icon: React.ElementType;
    title: (n: number) => string;
    detail: string;
    to: string;
    tone: 'warning' | 'destructive' | 'info';
}

const ITEMS: Item[] = [
    {
        key: 'drafts',
        icon: FileEdit,
        title: (n) => `${n} ${pluralize(n, 'draft')} to review`,
        detail: 'Processed but not yet saved to Records',
        to: '/recorded?status=draft',
        tone: 'warning',
    },
    {
        key: 'needs_calibration',
        icon: ScanLine,
        title: (n) => `${n} ${pluralize(n, 'image')} without calibration`,
        detail: 'Set the scale before sizes can be measured',
        to: '/recorded',
        tone: 'warning',
    },
    {
        key: 'unmeasured_images',
        icon: Ruler,
        title: (n) => `${n} ${pluralize(n, 'image')} counted, not measured`,
        detail: 'Count-only larvae / pupae images — measure when you need sizes',
        to: '/recorded',
        tone: 'info',
    },
    {
        key: 'low_confidence_images',
        icon: Gauge,
        title: (n) => `${n} low-confidence ${pluralize(n, 'image')}`,
        detail: 'Mean detection confidence below 50%',
        to: '/recorded',
        tone: 'warning',
    },
    {
        key: 'failed',
        icon: AlertCircle,
        title: (n) => `${n} failed ${pluralize(n, 'batch', 'batches')}`,
        detail: 'Processing stopped before finishing',
        to: '/recorded?status=failed',
        tone: 'destructive',
    },
];

const TONE: Record<Item['tone'], string> = {
    warning: 'bg-warning/10 text-warning',
    destructive: 'bg-destructive/10 text-destructive',
    info: 'bg-info/10 text-info',
};

export function AttentionCard({ attention }: { attention: DashboardAttention }) {
    const open = ITEMS.filter((item) => attention[item.key] > 0);

    return (
        <section className="panel flex h-full min-w-0 flex-col">
            <header className="px-5 pt-4">
                <h2 className="text-sm font-semibold">Needs attention</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Across all your batches</p>
            </header>
            {open.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center">
                    <CheckCircle2 className="size-6 text-success" aria-hidden />
                    <p className="text-sm font-medium">All caught up</p>
                    <p className="max-w-56 text-xs text-muted-foreground">
                        Nothing is waiting for review, calibration or measurement.
                    </p>
                </div>
            ) : (
                <ul className="flex-1 space-y-1 p-2.5 pt-3">
                    {open.map((item) => {
                        const Icon = item.icon;
                        return (
                            <li key={item.key}>
                                <Link
                                    to={item.to}
                                    className={cn(
                                        'group flex items-center gap-3 rounded-lg px-2.5 py-2',
                                        'transition-colors duration-150 hover:bg-muted/70',
                                        'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'flex size-8 shrink-0 items-center justify-center rounded-md',
                                            TONE[item.tone],
                                        )}
                                    >
                                        <Icon className="size-4" aria-hidden />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-medium">
                                            {item.title(attention[item.key])}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {item.detail}
                                        </span>
                                    </span>
                                    <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" />
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
