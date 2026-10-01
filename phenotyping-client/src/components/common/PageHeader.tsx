// PageHeader — the title block every shell page opens with: optional eyebrow,
// title, one-line description, actions on the right, and an optional toolbar
// row (filters, tabs) underneath.

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface PageHeaderProps {
    eyebrow?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    /** Right-aligned buttons. */
    actions?: ReactNode;
    /** Second row — filters, tabs, search. */
    children?: ReactNode;
    className?: string;
}

export function PageHeader({
    eyebrow,
    title,
    description,
    actions,
    children,
    className,
}: PageHeaderProps) {
    return (
        <header className={cn('flex flex-col gap-4', className)}>
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                <div className="min-w-0">
                    {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
                    <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
                    {description && (
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                {actions && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
                )}
            </div>
            {children}
        </header>
    );
}
