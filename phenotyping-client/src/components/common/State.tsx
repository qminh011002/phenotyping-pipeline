// State — centered, fade-in feedback components: LoadingState, ErrorState, EmptyState.
// All use <FadeIn> from FE-021 motion primitives.

import { AlertCircle, RefreshCw, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from './Spinner';
import { FadeIn } from '@/components/motion/primitives';

// ── LoadingState ─────────────────────────────────────────────────────────────

interface LoadingStateProps {
    label?: string;
    size?: 'sm' | 'md' | 'lg';
}

export function LoadingState({ label, size = 'md' }: LoadingStateProps) {
    return (
        <FadeIn className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <Spinner size={size} />
            {label && <p className="text-sm text-muted-foreground">{label}</p>}
        </FadeIn>
    );
}

// ── ErrorState ───────────────────────────────────────────────────────────────

interface ErrorStateProps {
    message?: string;
    title?: string;
    onRetry?: () => void;
    onBack?: () => void;
}

export function ErrorState({
    message,
    title = 'Something went wrong',
    onRetry,
    onBack,
}: ErrorStateProps) {
    return (
        <FadeIn className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div role="alert" className="flex max-w-sm flex-col items-center">
                <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/10 text-destructive">
                    <AlertCircle className="size-5" aria-hidden />
                </div>
                <p className="text-sm font-semibold text-foreground">{title}</p>
                {message && (
                    <p
                        data-slot="alert-description"
                        className="mt-1 text-sm break-words text-muted-foreground"
                    >
                        {message}
                    </p>
                )}
            </div>
            {(onBack || onRetry) && (
                <div className="mt-5 flex items-center gap-2">
                    {onBack && (
                        <Button variant="outline" size="sm" onClick={onBack}>
                            Go back
                        </Button>
                    )}
                    {onRetry && (
                        <Button size="sm" onClick={onRetry}>
                            <RefreshCw className="size-3.5" aria-hidden />
                            Retry
                        </Button>
                    )}
                </div>
            )}
        </FadeIn>
    );
}

// ── EmptyState ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
    icon: LucideIcon;
    title: string;
    description?: string;
    actionLabel?: string;
    onAction?: () => void;
}

export function EmptyState({
    icon: Icon,
    title,
    description,
    actionLabel,
    onAction,
}: EmptyStateProps) {
    return (
        <FadeIn className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                <Icon className="size-5" aria-hidden />
            </div>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            {description && (
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
            )}
            {actionLabel && onAction && (
                <Button variant="outline" size="sm" className="mt-5" onClick={onAction}>
                    {actionLabel}
                </Button>
            )}
        </FadeIn>
    );
}
