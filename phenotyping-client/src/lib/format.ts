// Display formatting shared by every page — one place so a count, a duration
// or a date reads the same on the dashboard, in Records and in the viewer.

const compactFormatter = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
});
const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** 1,284 — full precision with grouping. `—` for missing values. */
export function formatCount(n: number | null | undefined): string {
    return n == null ? '—' : n.toLocaleString();
}

/** 1,284 → 1.3K. Use where space is tight; prefer `formatCount` in tables. */
export function formatCompact(n: number | null | undefined): string {
    if (n == null) return '—';
    return Math.abs(n) < 10_000 ? n.toLocaleString() : compactFormatter.format(n);
}

export function formatNumber(n: number | null | undefined, digits = 1): string {
    return n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits);
}

/** 0.873 → "87.3%". */
export function formatPercent(fraction: number | null | undefined, digits = 1): string {
    return fraction == null ? '—' : `${(fraction * 100).toFixed(digits)}%`;
}

/** Seconds → "840 ms" / "12.4 s" / "3m 05s". */
export function formatDuration(seconds: number | null | undefined): string {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
    if (seconds < 60) return `${seconds.toFixed(1)} s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Running clock for something still in flight: "0:42", "12:05", "1:02:33". */
export function formatElapsed(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(iso: string): string {
    return dateFormatter.format(new Date(iso));
}

export function formatShortDate(iso: string): string {
    return shortDateFormatter.format(new Date(iso));
}

export function formatMonth(iso: string): string {
    return monthFormatter.format(new Date(iso));
}

export function formatTime(iso: string): string {
    return timeFormatter.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
    return `${formatDate(iso)} · ${formatTime(iso)}`;
}

/** "just now", "12m ago", "3h ago", "5d ago", then a date. */
export function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '—';
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return formatDate(iso);
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
    return n === 1 ? singular : plural;
}
