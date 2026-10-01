// LogFilterBar — level toggle buttons, connection status, clear, and pause/resume.

import { memo } from 'react';
import { ArrowUpToLine, Pause, Trash2, Wifi, WifiOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { LogLevel } from '@/types/api';
import type { LogFilters, WsStatus } from '../hooks/useLogs';

const LEVELS: { level: LogLevel; label: string; name: string; dot: string }[] = [
    { level: 'DEBUG', label: 'DBG', name: 'debug', dot: 'bg-muted-foreground' },
    { level: 'INFO', label: 'INF', name: 'info', dot: 'bg-info' },
    { level: 'WARNING', label: 'WRN', name: 'warning', dot: 'bg-warning' },
    { level: 'ERROR', label: 'ERR', name: 'error', dot: 'bg-destructive' },
];

interface LogFilterBarProps {
    filters: LogFilters;
    wsStatus: WsStatus;
    autoScroll: boolean;
    filteredCount: number;
    totalCount: number;
    onToggle: (level: LogLevel) => void;
    onClear: () => void;
    onAutoScroll: (v: boolean) => void;
}

function ConnectionStatus({ wsStatus }: { wsStatus: WsStatus }) {
    if (wsStatus === 'connecting') {
        return (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <span className="size-2 animate-pulse rounded-full bg-warning" aria-hidden />
                Connecting…
            </span>
        );
    }
    if (wsStatus === 'connected') {
        return (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <span className="size-2 rounded-full bg-success" aria-hidden />
                <Wifi className="size-3.5 text-success" aria-hidden />
                Live
            </span>
        );
    }
    return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <span className="size-2 rounded-full bg-destructive" aria-hidden />
            <WifiOff className="size-3.5 text-destructive" aria-hidden />
            Disconnected
        </span>
    );
}

export const LogFilterBar = memo(function LogFilterBar({
    filters,
    wsStatus,
    autoScroll,
    filteredCount,
    totalCount,
    onToggle,
    onClear,
    onAutoScroll,
}: LogFilterBarProps) {
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/40 px-3 py-2">
            {/* Connection status */}
            <ConnectionStatus wsStatus={wsStatus} />

            <div className="h-4 w-px bg-border" aria-hidden />

            {/* Level toggles */}
            <div role="group" aria-label="Log levels" className="flex items-center gap-1">
                {LEVELS.map(({ level, label, name, dot }) => {
                    const on = filters[level];
                    return (
                        <button
                            key={level}
                            type="button"
                            // Pressed = this level is shown.
                            aria-pressed={on}
                            aria-label={`Show ${name} entries`}
                            title={`${on ? 'Hide' : 'Show'} ${name} entries`}
                            onClick={() => onToggle(level)}
                            className={cn(
                                'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] font-semibold tracking-wider transition-colors duration-150 ease-out',
                                'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                on
                                    ? 'border-border bg-card text-foreground shadow-xs'
                                    : 'border-transparent text-muted-foreground/70 hover:text-foreground',
                            )}
                        >
                            <span
                                aria-hidden
                                className={cn(
                                    'size-1.5 rounded-full',
                                    on ? dot : 'bg-muted-foreground/30',
                                )}
                            />
                            {label}
                        </button>
                    );
                })}
            </div>

            <div className="h-4 w-px bg-border" aria-hidden />

            {/* Count */}
            <span className="text-xs text-muted-foreground tabular-nums">
                {filteredCount < totalCount
                    ? `${filteredCount.toLocaleString()} of ${totalCount.toLocaleString()} entries`
                    : `${totalCount.toLocaleString()} ${pluralize(totalCount, 'entry', 'entries')}`}
            </span>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Auto-scroll — the newest entry is at the top of the list. */}
            <Button
                variant="outline"
                size="xs"
                aria-pressed={autoScroll}
                aria-label="Auto-scroll to the latest entry"
                className={autoScroll ? 'text-primary hover:text-primary' : undefined}
                onClick={() => onAutoScroll(!autoScroll)}
                title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
            >
                {autoScroll ? (
                    <ArrowUpToLine className="size-3.5" aria-hidden />
                ) : (
                    <Pause className="size-3.5" aria-hidden />
                )}
                {autoScroll ? 'Auto' : 'Paused'}
            </Button>

            {/* Clear */}
            <Button variant="secondary" size="xs" onClick={onClear} title="Clear log display">
                <Trash2 className="size-3.5" aria-hidden />
                Clear
            </Button>
        </div>
    );
});
