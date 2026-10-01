// FlowSteps — where the operator is in the new-analysis flow.

import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

const STEPS = ['Project', 'Images', 'Review'] as const;

interface FlowStepsProps {
    /** 1-based index of the step in progress. */
    current: 1 | 2 | 3;
    /** Override step labels (e.g. the append flow has no "Project" step to do). */
    labels?: readonly [string, string, string];
    className?: string;
}

export function FlowSteps({ current, labels = STEPS, className }: FlowStepsProps) {
    return (
        <ol
            aria-label={`Step ${current} of ${labels.length}`}
            className={cn('flex items-center gap-2 text-xs', className)}
        >
            {labels.map((label, i) => {
                const n = i + 1;
                const done = n < current;
                const active = n === current;
                return (
                    <li key={label} className="flex items-center gap-2">
                        {i > 0 && (
                            <span
                                aria-hidden
                                className={cn(
                                    'h-px w-6',
                                    done || active ? 'bg-primary/50' : 'bg-border',
                                )}
                            />
                        )}
                        <span
                            aria-current={active ? 'step' : undefined}
                            className={cn(
                                'flex items-center gap-1.5 font-medium',
                                active
                                    ? 'text-foreground'
                                    : done
                                      ? 'text-muted-foreground'
                                      : 'text-muted-foreground/70',
                            )}
                        >
                            <span
                                className={cn(
                                    'flex size-5 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
                                    active
                                        ? 'bg-primary text-primary-foreground'
                                        : done
                                          ? 'bg-primary/15 text-primary'
                                          : 'border border-border text-muted-foreground',
                                )}
                            >
                                {done ? <Check className="size-3" aria-hidden /> : n}
                            </span>
                            {label}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}
