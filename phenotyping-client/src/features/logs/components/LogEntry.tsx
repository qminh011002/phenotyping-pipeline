// LogEntry — single log line with timestamp, level badge, message, and expandable context.

import { useState, memo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { LogEntry, LogLevel } from '@/types/api';

const LEVEL_STYLES: Record<LogLevel, { label: string; badge: string; text: string }> = {
    DEBUG: {
        label: 'DBG',
        badge: 'bg-muted text-muted-foreground border-transparent',
        text: 'text-muted-foreground',
    },
    INFO: {
        label: 'INF',
        badge: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
        text: 'text-foreground',
    },
    WARNING: {
        label: 'WRN',
        badge: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
        text: 'text-yellow-700 dark:text-yellow-300',
    },
    ERROR: {
        label: 'ERR',
        badge: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
        text: 'text-red-600 dark:text-red-400',
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

    return (
        <div className="group font-mono text-xs leading-5">
            <div
                className={cn(
                    'flex items-start gap-2 px-3 py-1 hover:bg-accent/40 cursor-pointer rounded-sm',
                    style.text,
                )}
                onClick={() => hasContext && setExpanded((v) => !v)}
            >
                {/* Timestamp */}
                <span className="shrink-0 select-all text-muted-foreground/60">
                    {formatTimestamp(entry.timestamp)}
                </span>

                {/* Level badge */}
                <Badge
                    variant="outline"
                    className={cn(
                        'shrink-0 h-4 px-1 py-0 text-[10px] font-bold tracking-wider self-center',
                        style.badge,
                    )}
                >
                    {style.label}
                </Badge>

                {/* Message */}
                <span className="min-w-0 flex-1 break-all select-all">{entry.message}</span>

                {/* Expand toggle */}
                {hasContext && (
                    <span className="shrink-0 self-center text-muted-foreground">
                        {expanded ? (
                            <ChevronDown className="h-3 w-3" />
                        ) : (
                            <ChevronRight className="h-3 w-3" />
                        )}
                    </span>
                )}
            </div>

            {/* Expanded context */}
            {expanded && hasContext && (
                <div className="ml-10 mr-3 mb-1 rounded border bg-muted/50 px-3 py-2 select-all">
                    <pre className="whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
                        {JSON.stringify(entry.context, null, 2)}
                    </pre>
                </div>
            )}
        </div>
    );
});
