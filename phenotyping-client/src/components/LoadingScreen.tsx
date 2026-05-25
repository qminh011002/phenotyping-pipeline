import type { ReactNode } from 'react';

interface LoadingScreenProps {
    title?: string;
    status?: string;
    counter?: string;
    action?: ReactNode;
    children?: ReactNode;
}

export function LoadingScreen({
    title = 'phenotyping',
    status = 'Loading...',
    counter,
    action,
    children,
}: LoadingScreenProps) {
    return (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background px-6">
            <h1 className="text-3xl font-semibold tracking-tight text-primary">{title}</h1>
            <img
                src="/assets/gif/worm_cute_antennae.gif"
                alt=""
                aria-hidden
                className="mt-2 h-20 w-auto [image-rendering:pixelated]"
            />
            <p className="mt-5 text-sm font-medium text-foreground">{status}</p>
            {counter && (
                <p className="mt-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                    {counter}
                </p>
            )}
            {children}
            {action && <div className="mt-6">{action}</div>}
        </div>
    );
}
