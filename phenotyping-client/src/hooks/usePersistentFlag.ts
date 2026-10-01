// usePersistentFlag — a boolean UI preference remembered in localStorage
// (collapsed panels, view toggles). Falls back to in-memory state when
// storage is unavailable.

import { useCallback, useState } from 'react';

function read(key: string): boolean | null {
    try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? null : raw === '1';
    } catch {
        return null;
    }
}

export function usePersistentFlag(
    key: string,
    defaultValue: boolean,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
    const [value, setValue] = useState<boolean>(() => read(key) ?? defaultValue);

    const set = useCallback(
        (next: boolean | ((prev: boolean) => boolean)) => {
            setValue((prev) => {
                const resolved = typeof next === 'function' ? next(prev) : next;
                try {
                    window.localStorage.setItem(key, resolved ? '1' : '0');
                } catch {
                    // Private mode / quota — the preference just won't persist.
                }
                return resolved;
            });
        },
        [key],
    );

    return [value, set];
}

/** Stored value, or null when the user never chose. */
export function readPersistentFlag(key: string): boolean | null {
    return read(key);
}
