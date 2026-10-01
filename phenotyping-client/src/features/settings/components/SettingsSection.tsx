// Layout pieces shared by the Settings and Models screens.
//
//   SettingsSection — the bordered panel every block sits in. `split` puts the
//                     title + one-line description on the left and the controls
//                     on the right; `stacked` puts them in a header row above
//                     full-width content (lists, the log viewer).
//   GroupHeading    — titles a run of panels on a page with several groups.
//   FactList        — a compact row of label/value facts.
//   Chip            — the small status / kind label used across these screens.
//   OrganismLabel   — an organism's colour dot + name, for row and tab labels.

import type { ReactNode } from 'react';

import { organismMeta } from '@/lib/organism';
import { cn } from '@/lib/utils';

// ── SettingsSection ──────────────────────────────────────────────────────────

interface SettingsSectionProps {
    title: ReactNode;
    description?: ReactNode;
    /** Buttons that act on the whole section (refresh, upload). */
    actions?: ReactNode;
    /** Row under the description — status chips, counts. */
    meta?: ReactNode;
    layout?: 'split' | 'stacked';
    /** Stacked only: no content padding, so lists and viewers run edge to edge. */
    flush?: boolean;
    /** Heading level of the title. */
    as?: 'h2' | 'h3';
    children: ReactNode;
    className?: string;
}

export function SettingsSection({
    title,
    description,
    actions,
    meta,
    layout = 'split',
    flush = false,
    as: Heading = 'h2',
    children,
    className,
}: SettingsSectionProps) {
    if (layout === 'stacked') {
        return (
            <section className={cn('panel overflow-hidden', className)}>
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-5">
                    <div className="min-w-0 flex-1 basis-72">
                        <Heading className="text-sm font-semibold">{title}</Heading>
                        {description && (
                            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                                {description}
                            </p>
                        )}
                        {meta && (
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                {meta}
                            </div>
                        )}
                    </div>
                    {actions && (
                        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
                    )}
                </div>
                <div className={cn('border-t border-border', !flush && 'p-5')}>{children}</div>
            </section>
        );
    }

    return (
        <section className={cn('panel', className)}>
            <div className="grid gap-x-10 gap-y-5 p-5 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
                <div className="min-w-0">
                    <Heading className="text-sm font-semibold">{title}</Heading>
                    {description && (
                        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    )}
                    {meta && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {meta}
                        </div>
                    )}
                    {actions && (
                        <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
                    )}
                </div>
                <div className="min-w-0">{children}</div>
            </div>
        </section>
    );
}

// ── GroupHeading ─────────────────────────────────────────────────────────────

interface GroupHeadingProps {
    eyebrow?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    /** Right-aligned facts or buttons. */
    aside?: ReactNode;
}

export function GroupHeading({ eyebrow, title, description, aside }: GroupHeadingProps) {
    return (
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-72">
                {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
                <h2 className="text-base font-semibold tracking-tight">{title}</h2>
                {description && (
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
                )}
            </div>
            {aside && <div className="max-w-full min-w-0">{aside}</div>}
        </div>
    );
}

// ── FactList ─────────────────────────────────────────────────────────────────

export interface Fact {
    label: string;
    value: ReactNode;
    /** Native tooltip — the full value when it may be truncated. */
    title?: string;
}

export function FactList({ facts, className }: { facts: Fact[]; className?: string }) {
    return (
        <dl
            className={cn(
                'flex max-w-full divide-x divide-border overflow-hidden rounded-lg border border-border bg-card',
                className,
            )}
        >
            {facts.map((fact) => (
                <div key={fact.label} className="min-w-0 px-3 py-1.5">
                    <dt className="eyebrow">{fact.label}</dt>
                    <dd
                        className="max-w-56 truncate text-sm font-semibold tabular-nums"
                        title={fact.title}
                    >
                        {fact.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

// ── Chip ─────────────────────────────────────────────────────────────────────

type ChipTone = 'neutral' | 'outline' | 'primary' | 'success' | 'warning' | 'info' | 'destructive';

const CHIP_TONES: Record<ChipTone, string> = {
    neutral: 'border-border bg-muted text-muted-foreground',
    outline: 'border-border bg-card text-foreground',
    primary: 'border-primary/25 bg-primary/10 text-primary',
    success: 'border-success/25 bg-success/10 text-success',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    info: 'border-info/25 bg-info/10 text-info',
    destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
};

interface ChipProps {
    tone?: ChipTone;
    title?: string;
    className?: string;
    children: ReactNode;
}

export function Chip({ tone = 'neutral', title, className, children }: ChipProps) {
    return (
        <span
            title={title}
            className={cn(
                'inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium whitespace-nowrap',
                CHIP_TONES[tone],
                className,
            )}
        >
            {children}
        </span>
    );
}

// ── OrganismLabel ────────────────────────────────────────────────────────────

interface OrganismLabelProps {
    organism: string;
    /** Text after the organism name, e.g. "mode". */
    suffix?: string;
    className?: string;
}

export function OrganismLabel({ organism, suffix, className }: OrganismLabelProps) {
    const meta = organismMeta(organism);
    return (
        <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
            {/* The dot carries the organism's chart colour; the text stays in ink. */}
            <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: meta.color }}
            />
            <span className="truncate">{suffix ? `${meta.label} ${suffix}` : meta.label}</span>
        </span>
    );
}
