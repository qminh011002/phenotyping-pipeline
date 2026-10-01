// The path of every history entry this tab has visited, by its position in
// the browser's history stack. React Router stamps each entry with an `idx`;
// we remember which path sits at which index, so a "Back" control can tell
// whether the screen it returns to is the entry right behind the current one.
//
// Kept in sessionStorage: the browser's history survives a reload, so the
// trail has to as well.

const STORAGE_KEY = 'phenotyping.nav-trail';

function read(): Array<string | null> {
    try {
        const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const trail = read();

function currentIndex(): number | null {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    return typeof idx === 'number' ? idx : null;
}

/** Remember `path` (pathname + search) as the current history entry. */
export function recordLocation(path: string): void {
    const idx = currentIndex();
    if (idx === null) return;
    // Entries past the current one are either a forward branch that is still
    // valid or one a push just discarded — both get rewritten when visited.
    trail[idx] = path;
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail));
    } catch {
        // Storage full or blocked: back controls fall back to `replace`.
    }
}

/** Path of the entry one step back in this tab's history, if we saw it. */
export function previousPath(): string | null {
    const idx = currentIndex();
    if (idx === null || idx < 1) return null;
    return trail[idx - 1] ?? null;
}
