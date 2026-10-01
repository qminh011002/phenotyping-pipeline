// LogEntry — single log line with timestamp, level badge, message, and expandable context.

import { useState, memo, type KeyboardEvent } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { LogEntry, LogLevel } from '@/types/api';

// The badge carries the level's colour; message text stays in ink (errors
// excepted) so long lines remain readable in both themes.
const LEVEL_STYLES: Record<LogLevel, { label: string; badge: string; text: string }> = {
    DEBUG: {
        label: 'DBG',
        badge: 'border-border bg-muted text-muted-foreground',
        text: 'text-muted-foreground',
    },
    INFO: {
        label: 'INF',
        badge: 'border-info/25 bg-info/10 text-info',
        text: 'text-foreground',
    },
    WARNING: {
        label: 'WRN',
        badge: 'border-warning/30 bg-warning/10 text-warning',
        text: 'text-foreground',
    },
    ERROR: {
        label: 'ERR',
        badge: 'border-destructive/25 bg-destructive/10 text-destructive',
        text: 'text-destructive',
    },
};

function formatTimestamp(iso: string): string {
    try {
        const d = new Date(iso);
        const hh = d.getHours().toString().padStart(2, '0');
        const mm = d.getMinutes().toString().padStart(2, '0');
        const ss = d.getSeconds().toString().padStart(2, '0');
        const ms = d.getMilliseconds().toString().padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    } catch {
        return iso;
    }
}

interface LogEntryProps {
    entry: LogEntry;
}

export const LogEntryRow = memo(function LogEntryRow({ entry }: LogEntryProps) {
    const [expanded, setExpanded] = useState(false);
    const style = LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.INFO;
    const hasContext = entry.context && Object.keys(entry.context).length > 0;

    function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
        }
    }

    return (
        <div className="font-mono text-xs leading-5">
            <div
                // Rows with context expand on click or Enter / Space.
                role={hasContext ? 'button' : undefined}
                tabIndex={hasContext ? 0 : undefined}
                aria-expanded={hasContext ? expanded : undefined}
                onClick={() => hasContext && setExpanded((v) => !v)}
                onKeyDown={hasContext ? handleKeyDown : undefined}
                className={cn(
                    'flex items-start gap-2 px-3 py-1 transition-colors duration-150 ease-out hover:bg-accent/60',
                    hasContext &&
                        'cursor-pointer focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
                    style.text,
                )}
            >
                {/* Timestamp */}
                <span className="shrink-0 text-muted-foreground tabular-nums select-all">
                    {formatTimestamp(entry.timestamp)}
                </span>

                {/* Level badge */}
                <span
                    className={cn(
                        'mt-0.5 inline-flex h-4 w-8 shrink-0 items-center justify-center rounded-sm border text-[10px] font-semibold tracking-wider',
                        style.badge,
                    )}
                >
                    {style.label}
                </span>

                {/* Message */}
                <span className="min-w-0 flex-1 break-all select-all">{entry.message}</span>

                {/* Expand toggle */}
                {hasContext && (
                    <span className="mt-1 shrink-0 text-muted-foreground" aria-hidden>
                        {expanded ? (
                            <ChevronDown className="size-3" />
                        ) : (
                            <ChevronRight className="size-3" />
                        )}
                    </span>
                )}
            </div>

            {/* Expanded context */}
            {expanded && hasContext && (
                <div className="mx-3 mb-1 rounded-md border border-border bg-muted/50 px-3 py-2 select-all">
                    <pre className="text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
                        {JSON.stringify(entry.context, null, 2)}
                    </pre>
                </div>
            )}
        </div>
    );
});
