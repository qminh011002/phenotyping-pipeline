// useAuthedImage — load an image from an authenticated API route.
//
// The backend's image routes need a Bearer token, which a bare `<img src>`
// can't send. This fetches the bytes through the http client and hands back
// an object URL. Results are cached per URL for the page lifetime (LRU), so
// grids and filmstrips that remount don't re-download.
//
// Meant for thumbnails and other small images — the cache holds decoded
// blobs. The result viewer loads full-resolution images itself.

import { useEffect, useState } from 'react';

import { http } from '@/services/http';

const CACHE_MAX = 400;
const CONCURRENCY = 6;

interface Entry {
    url: string;
    refCount: number;
}

// Map preserves insertion order; eviction walks from the oldest.
const cache = new Map<string, Promise<Entry>>();

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
    if (active < CONCURRENCY) {
        active++;
        return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
    const next = waiters.shift();
    if (next) next();
    else active--;
}

async function load(src: string): Promise<Entry> {
    await acquire();
    try {
        // No AbortSignal: the promise is shared by every consumer of this
        // URL, so one unmount must not cancel the fetch for the others.
        const blob = await http.getBlob(src);
        return { url: URL.createObjectURL(blob), refCount: 0 };
    } finally {
        release();
    }
}

async function evictIfNeeded(): Promise<void> {
    if (cache.size <= CACHE_MAX) return;
    for (const [key, pending] of cache) {
        if (cache.size <= CACHE_MAX) break;
        const entry = await pending.catch(() => null);
        if (entry && entry.refCount > 0) continue;
        if (entry) URL.revokeObjectURL(entry.url);
        cache.delete(key);
    }
}

function getOrLoad(src: string): Promise<Entry> {
    const existing = cache.get(src);
    if (existing) {
        cache.delete(src);
        cache.set(src, existing); // bump LRU position
        return existing;
    }
    const fresh = load(src);
    cache.set(src, fresh);
    // A failed load must not poison the cache — let the next consumer retry.
    fresh.catch(() => {
        if (cache.get(src) === fresh) cache.delete(src);
    });
    void evictIfNeeded();
    return fresh;
}

/** Drop cached images whose URL contains `fragment` (e.g. an image id after
 *  its overlay was re-rendered). In-use entries are left for their consumers. */
export function invalidateAuthedImages(fragment: string): void {
    for (const [key, pending] of cache) {
        if (!key.includes(fragment)) continue;
        cache.delete(key);
        void pending
            .then((entry) => {
                if (entry.refCount === 0) URL.revokeObjectURL(entry.url);
            })
            .catch(() => {});
    }
}

/**
 * Returns an object URL for `src` once loaded (`null` until then).
 * Pass `enabled = false` to defer the request — e.g. until the element
 * scrolls into view.
 */
export function useAuthedImage(
    src: string | null,
    enabled = true,
): { url: string | null; error: boolean } {
    const [state, setState] = useState<{ src: string | null; url: string | null; error: boolean }>({
        src: null,
        url: null,
        error: false,
    });

    useEffect(() => {
        if (!src || !enabled) return;
        let cancelled = false;
        let held: Entry | null = null;
        getOrLoad(src)
            .then((entry) => {
                if (cancelled) return;
                entry.refCount++;
                held = entry;
                setState({ src, url: entry.url, error: false });
            })
            .catch(() => {
                if (!cancelled) setState({ src, url: null, error: true });
            });
        return () => {
            cancelled = true;
            if (held) held.refCount = Math.max(0, held.refCount - 1);
        };
    }, [src, enabled]);

    // A stale result for a previous `src` must not flash while the new one loads.
    if (state.src !== src) return { url: null, error: false };
    return { url: state.url, error: state.error };
}
