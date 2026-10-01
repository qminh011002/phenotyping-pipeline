// SegmentedControl — a compact single-choice switch (2–5 options). Arrow keys
// move the selection, like a native radio group.

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string | number> {
    value: T;
    label: ReactNode;
    /** Shown as a native tooltip. */
    title?: string;
    disabled?: boolean;
}

interface SegmentedControlProps<T extends string | number> {
    value: T;
    onChange: (value: T) => void;
    options: SegmentedOption<T>[];
    'aria-label': string;
    size?: 'sm' | 'md';
    className?: string;
}

export function SegmentedControl<T extends string | number>({
    value,
    onChange,
    options,
    size = 'md',
    className,
    ...aria
}: SegmentedControlProps<T>) {
    function move(from: number, step: 1 | -1) {
        for (let i = 1; i <= options.length; i++) {
            const next = options[(from + step * i + options.length * i) % options.length];
            if (!next.disabled) {
                onChange(next.value);
                return;
            }
        }
    }

    return (
        <div
            role="radiogroup"
            aria-label={aria['aria-label']}
            className={cn(
                'inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5',
                className,
            )}
        >
            {options.map((option, index) => {
                const selected = option.value === value;
                return (
                    <button
                        key={String(option.value)}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        disabled={option.disabled}
                        title={option.title}
                        onClick={() => onChange(option.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                                e.preventDefault();
                                move(index, 1);
                            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                                e.preventDefault();
                                move(index, -1);
                            }
                        }}
                        className={cn(
                            'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 ease-out',
                            'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            'disabled:pointer-events-none disabled:opacity-50',
                            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
                            selected
                                ? 'bg-card text-foreground shadow-xs'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
