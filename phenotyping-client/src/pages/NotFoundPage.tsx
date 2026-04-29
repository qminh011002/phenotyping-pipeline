// NotFoundPage — terminal 404 for any URL the router can't match.
// Mounted as the catch-all `*` route below the authed/anon trees in App.tsx.

import { useNavigate, useLocation } from 'react-router-dom';
import { Home, ArrowLeft, Compass } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
    const navigate = useNavigate();
    const location = useLocation();

    return (
        <div className="flex h-screen w-full items-center justify-center bg-background p-6">
            <div className="flex w-full max-w-md flex-col items-center text-center">
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted">
                    <Compass className="h-10 w-10 text-muted-foreground" />
                </div>

                <p className="mt-6 text-sm font-mono font-semibold tracking-[0.2em] text-muted-foreground">
                    404
                </p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight">
                    Page not found
                </h1>
                <p className="mt-3 text-sm text-muted-foreground">
                    The link you followed may be broken, or the page may have been
                    moved.
                </p>

                {location.pathname && (
                    <code className="mt-4 max-w-full truncate rounded-md bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
                        {location.pathname}
                    </code>
                )}

                <div className="mt-8 flex flex-col gap-2 sm:flex-row">
                    <Button
                        variant="outline"
                        onClick={() => navigate(-1)}
                        className="gap-2"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Go back
                    </Button>
                    <Button onClick={() => navigate('/')} className="gap-2">
                        <Home className="h-4 w-4" />
                        Back to home
                    </Button>
                </div>
            </div>
        </div>
    );
}
