// NotFoundPage — terminal 404 for any URL the router can't match.
// Mounted as the catch-all `*` route below the authed/anon trees in App.tsx.

import { useNavigate, useLocation } from 'react-router-dom';
import { Home, ArrowLeft, Compass } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
    const navigate = useNavigate();
    const location = useLocation();

    return (
        <div className="flex min-h-screen w-full items-center justify-center bg-background px-6 py-10">
            <main className="flex w-full max-w-md flex-col items-center text-center">
                <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted text-muted-foreground">
                    <Compass className="size-6" aria-hidden />
                </div>

                <p className="eyebrow mt-6 font-mono">404</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">Page not found</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                    The link you followed may be broken, or the page may have been moved.
                </p>

                {location.pathname && (
                    <code
                        className="mt-4 max-w-full truncate rounded-md border border-border bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground"
                        title={location.pathname}
                    >
                        {location.pathname}
                    </code>
                )}

                <div className="mt-8 flex flex-col gap-2 sm:flex-row">
                    <Button variant="outline" onClick={() => navigate(-1)}>
                        <ArrowLeft className="size-4" aria-hidden />
                        Go back
                    </Button>
                    <Button onClick={() => navigate('/')}>
                        <Home className="size-4" aria-hidden />
                        Back to home
                    </Button>
                </div>
            </main>
        </div>
    );
}
