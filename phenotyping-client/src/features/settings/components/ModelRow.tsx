// Rows shared by the model lists (detection weights and SAM weights): one
// weight file per row with its kind / active chips, a meta line, and actions.

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Chip } from './SettingsSection';

/** Marks the model that inference currently uses. */
export function ActiveChip() {
    return (
        <Chip tone="success">
            <Check className="size-3" aria-hidden />
            Active
        </Chip>
    );
}

/** A labelled band between groups of rows inside one panel. */
export function ModelListHeading({ children }: { children: ReactNode }) {
    return (
        <p className="eyebrow border-b border-border bg-muted/40 px-5 py-2 not-first:border-t">
            {children}
        </p>
    );
}

export function ModelList({ children }: { children: ReactNode }) {
    return <ul className="divide-y divide-border">{children}</ul>;
}

interface ModelRowProps {
    filename: string;
    /** Kind + state chips shown next to the filename. */
    badges?: ReactNode;
    /** Second line — size, upload date, source folder. */
    meta?: ReactNode;
    active?: boolean;
    actions?: ReactNode;
}

export function ModelRow({ filename, badges, meta, active = false, actions }: ModelRowProps) {
    return (
        <li
            className={cn(
                'flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between',
                active && 'bg-primary/5',
            )}
        >
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <span
                        className={cn('truncate font-mono text-sm', active && 'font-medium')}
                        title={filename}
                    >
                        {filename}
                    </span>
                    {badges}
                </div>
                {meta && (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {meta}
                    </div>
                )}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </li>
    );
}

/** Placeholder line for a list with nothing in it. */
export function ModelListEmpty({ children }: { children: ReactNode }) {
    return <p className="px-5 py-5 text-sm text-muted-foreground">{children}</p>;
}
