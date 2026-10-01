import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { previousPath } from '@/lib/navTrail';

/**
 * Navigation for controls that *close* a screen — back arrows, Cancel,
 * "Save and exit". Pushing the parent's URL would leave the closed screen
 * behind it in history, so the browser's Back button would reopen it.
 *
 * Instead: when the entry right behind this one already is the target, step
 * back to it (its scroll position and forward history stay intact). Otherwise
 * — a deep link, a reload in a new tab, or arriving from somewhere else —
 * replace the current entry with the target.
 *
 * `isTarget` widens the match when several URLs show the same screen
 * (e.g. the Recorded list with or without a `?status=` filter).
 */
export function useBackTo() {
    const navigate = useNavigate();
    return useCallback(
        (target: string, isTarget: (path: string) => boolean = (path) => path === target) => {
            const previous = previousPath();
            if (previous !== null && isTarget(previous)) {
                navigate(-1);
            } else {
                navigate(target, { replace: true });
            }
        },
        [navigate],
    );
}
