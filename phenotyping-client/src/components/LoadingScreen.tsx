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
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
            <h1 className="text-5xl font-bold tracking-tight text-primary">{title}</h1>
            <img
                src="/assets/gif/worm_cute_antennae.gif"
                alt=""
                aria-hidden
                className="h-24 w-auto [image-rendering:pixelated]"
            />
            <p className="mt-6 font-mono text-sm text-muted-foreground">{status}</p>
            {counter && (
                <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">
                    {counter}
                </p>
            )}
            {children}
            {action && <div className="mt-8">{action}</div>}
        </div>
    );
}
