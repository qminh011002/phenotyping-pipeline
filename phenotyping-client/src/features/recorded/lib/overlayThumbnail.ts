// Overlay thumbnail pipeline for the recorded batch detail view.
//
// The recorded view lists every image in a batch. Feeding the browser a
// full-resolution overlay PNG per row is what makes that page feel sluggish:
// even when the <img> is displayed at 56 px, the browser still decodes the
// whole PNG into uncompressed pixels. A 4000×3000 PNG ~= 48 MB of decoded
// memory — times N rows and the tab starts swapping.
//
// Mirror what UploadPage does for local files: fetch the overlay once,
// draw it onto a 300 px-edge canvas at JPEG quality 0.4, hand back an
// object URL for the row to use. Clicks open the original URL.
//
// Design choices:
// - Module-level cache keyed by URL. BatchDetail remounts on navigation,
//   and the same overlay can appear in multiple hooks (StrictMode double-
//   mounts during dev); caching is cheap and prevents redundant work.
// - Shared concurrency semaphore. The browser already throttles connections,
//   but decoding + canvas ops compete for the main thread, so we cap at 4
//   parallel resizes — same ceiling UploadPage picked.
// - IntersectionObserver-gated start. Rows below the fold don't start
//   fetching until they're about to be visible, so opening a 200-image
//   batch doesn't kick off 200 simultaneous fetches.

import { useEffect, useRef, useState } from "react";

const THUMB_MAX_EDGE = 300;
const THUMB_QUALITY = 0.4;
const THUMB_CONCURRENCY = 4;

interface CacheEntry {
  url: string; // object URL for the downscaled JPEG
  refCount: number;
}

const cache = new Map<string, Promise<CacheEntry>>();

// Tiny semaphore — queue of resolver functions waiting for a slot.
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < THUMB_CONCURRENCY) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

async function buildThumbnail(srcUrl: string): Promise<CacheEntry> {
  await acquire();
  try {
    const resp = await fetch(srcUrl, { credentials: "same-origin" });
    if (!resp.ok) {
      throw new Error(`overlay fetch failed: ${resp.status}`);
    }
    const blob = await resp.blob();
    let objectUrl: string;
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(
        1,
        THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
      );
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      const out: Blob | null = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", THUMB_QUALITY),
      );
      if (!out) throw new Error("toBlob returned null");
      objectUrl = URL.createObjectURL(out);
    } catch {
      // Fallback: hand the raw blob back so the row at least shows *something*.
      // Still cheaper than letting <img src=remoteUrl> decode repeatedly.
      objectUrl = URL.createObjectURL(blob);
    }
    return { url: objectUrl, refCount: 0 };
  } finally {
    release();
  }
}

function getOrCreate(srcUrl: string): Promise<CacheEntry> {
  const existing = cache.get(srcUrl);
  if (existing) return existing;
  const fresh = buildThumbnail(srcUrl);
  cache.set(srcUrl, fresh);
  return fresh;
}

/**
 * React hook: returns a downscaled object URL for the overlay at `srcUrl`.
 * Returns `null` until the thumbnail is ready.
 *
 * `enabled` defaults to true. Pass `false` to defer work (e.g. gated on an
 * IntersectionObserver).
 */
export function useOverlayThumbnail(
  srcUrl: string | null,
  enabled: boolean = true,
): { thumbUrl: string | null; error: boolean } {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const lastSrcRef = useRef<string | null>(null);

  useEffect(() => {
    if (!srcUrl || !enabled) {
      setThumbUrl(null);
      setError(false);
      return;
    }
    let cancelled = false;
    lastSrcRef.current = srcUrl;
    setError(false);
    getOrCreate(srcUrl)
      .then((entry) => {
        if (cancelled || lastSrcRef.current !== srcUrl) return;
        entry.refCount++;
        setThumbUrl(entry.url);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      });
    return () => {
      cancelled = true;
      // Decrement on unmount — when refCount hits 0 we *could* revoke the
      // object URL and drop the cache entry, but navigating back to the
      // same batch is common so we keep thumbnails around for the page
      // lifetime. They're tiny JPEGs and the tab discards them on close.
      const settled = cache.get(srcUrl);
      if (!settled) return;
      settled.then((entry) => {
        entry.refCount = Math.max(0, entry.refCount - 1);
      });
    };
  }, [srcUrl, enabled]);

  return { thumbUrl, error };
}
