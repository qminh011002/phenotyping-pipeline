// AnalysisModePicker — how a larvae / pupae batch is processed.
//
// Count only (the default) stops after detection + dedup: the count is final
// at that point, and SAM refinement only changes how tight the outlines are.
// Sizes can be measured later, per image or for the whole batch, from the
// result viewer.

import { Hash, RulerDimensionLine } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AnalysisMode } from '@/types/api';

const OPTIONS: Array<{
    value: AnalysisMode;
    title: string;
    description: string;
    icon: React.ElementType;
    tag?: string;
}> = [
    {
        value: 'count',
        title: 'Count only',
        description:
            'Detect and count. Fastest. Measure sizes later from the result viewer, only where you need them.',
        icon: Hash,
        tag: 'Default',
    },
    {
        value: 'measure',
        title: 'Count + measure',
        description:
            'Also refine outlines with SAM and measure length, width and area on every image. Slower.',
        icon: RulerDimensionLine,
    },
];

interface AnalysisModePickerProps {
    value: AnalysisMode;
    onChange: (mode: AnalysisMode) => void;
    disabled?: boolean;
}

export function AnalysisModePicker({ value, onChange, disabled }: AnalysisModePickerProps) {
    return (
        <div role="radiogroup" aria-label="Analysis mode" className="flex flex-col gap-2">
            {OPTIONS.map((option) => {
                const selected = option.value === value;
                const Icon = option.icon;
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={disabled}
                        onClick={() => onChange(option.value)}
                        className={cn(
                            'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors duration-150',
                            'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            'disabled:pointer-events-none disabled:opacity-60',
                            selected
                                ? 'border-primary bg-primary/5'
                                : 'border-border bg-card hover:bg-muted/60',
                        )}
                    >
                        <span
                            className={cn(
                                'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md',
                                selected
                                    ? 'bg-primary/15 text-primary'
                                    : 'bg-muted text-muted-foreground',
                            )}
                        >
                            <Icon className="size-4" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                                {option.title}
                                {option.tag && (
                                    <span className="rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                                        {option.tag}
                                    </span>
                                )}
                            </span>
                            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                                {option.description}
                            </span>
                        </span>
                        <span
                            aria-hidden
                            className={cn(
                                'mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border',
                                selected ? 'border-primary' : 'border-input',
                            )}
                        >
                            {selected && <span className="size-2 rounded-full bg-primary" />}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
