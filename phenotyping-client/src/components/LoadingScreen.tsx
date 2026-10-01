// LoadingScreen — the full-screen brand loader: title, worm, a live status
// line, an optional counter, optional content below (e.g. the processing
// page's live log) and an optional action. Used by the boot provider, the
// processing page and the batch-open transition.

import type { ReactNode } from 'react';

interface LoadingScreenProps {
    title?: string;
    status?: string;
    counter?: string;
    action?: ReactNode;
    children?: ReactNode;
}

export function LoadingScreen({
    title = 'Phenotyping',
    status = 'Loading...',
    counter,
    action,
    children,
}: LoadingScreenProps) {
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
            {/* min-h-full keeps short content centred while tall content scrolls from the top. */}
            <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
                <img
                    src="/assets/gif/worm_cute_antennae.gif"
                    alt=""
                    aria-hidden
                    className="h-20 w-auto [image-rendering:pixelated]"
                />
                <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                    {title}
                </h1>
                <p
                    role="status"
                    aria-live="polite"
                    className="mt-4 max-w-md text-sm font-medium text-balance break-words text-foreground"
                >
                    {status}
                </p>
                {counter && (
                    <p className="mt-1.5 max-w-md font-mono text-xs break-words text-muted-foreground tabular-nums">
                        {counter}
                    </p>
                )}
                {children}
                {action && <div className="mt-6">{action}</div>}
            </div>
        </div>
    );
}
