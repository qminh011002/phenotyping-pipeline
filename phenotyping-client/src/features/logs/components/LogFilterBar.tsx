// LogFilterBar — level toggle buttons, connection status, clear, and pause/resume.

import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { LogFilters, WsStatus } from '../hooks/useLogs';
import type { LogLevel } from '@/types/api';
import { Trash2, ArrowDownToLine, ArrowUpToLine, Wifi, WifiOff } from 'lucide-react';

const LEVELS: { level: LogLevel; label: string; color: string }[] = [
    { level: 'DEBUG', label: 'DBG', color: 'text-muted-foreground' },
    { level: 'INFO', label: 'INF', color: 'text-blue-600 dark:text-blue-400' },
    { level: 'WARNING', label: 'WRN', color: 'text-yellow-600 dark:text-yellow-400' },
    { level: 'ERROR', label: 'ERR', color: 'text-red-600 dark:text-red-400' },
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
    const isConnected = wsStatus === 'connected';
    const isConnecting = wsStatus === 'connecting';

    return (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            {/* Connection status */}
            <div className="flex items-center gap-1.5 text-xs">
                {isConnecting ? (
                    <>
                        <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                        <span className="text-muted-foreground">Connecting…</span>
                    </>
                ) : isConnected ? (
                    <>
                        <span className="h-2 w-2 rounded-full bg-green-500" />
                        <Wifi className="h-3 w-3 text-green-500" />
                    </>
                ) : (
                    <>
                        <span className="h-2 w-2 rounded-full bg-red-500" />
                        <WifiOff className="h-3 w-3 text-red-500" />
                        <span className="text-muted-foreground">Disconnected</span>
                    </>
                )}
            </div>

            <div className="h-4 w-px bg-border" />

            {/* Level toggles */}
            {LEVELS.map(({ level, label, color }) => (
                <Button
                    key={level}
                    variant="outline"
                    size="sm"
                    className={cn(
                        'h-6 px-2 text-[11px] font-bold tracking-wider transition-colors',
                        filters[level]
                            ? color
                            : 'text-muted-foreground/40 border-transparent bg-transparent',
                    )}
                    onClick={() => onToggle(level)}
                >
                    {label}
                </Button>
            ))}

            <div className="h-4 w-px bg-border" />

            {/* Count */}
            <span className="text-xs text-muted-foreground">
                {filteredCount < totalCount ? `${filteredCount} / ${totalCount}` : `${totalCount}`}
            </span>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Auto-scroll */}
            <Button
                variant="ghost"
                size="sm"
                className={cn(
                    'h-6 gap-1 px-2 text-xs',
                    autoScroll ? 'text-primary' : 'text-muted-foreground',
                )}
                onClick={() => onAutoScroll(!autoScroll)}
                title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
            >
                {autoScroll ? (
                    <ArrowDownToLine className="h-3.5 w-3.5" />
                ) : (
                    <ArrowUpToLine className="h-3.5 w-3.5" />
                )}
                {autoScroll ? 'Auto' : 'Paused'}
            </Button>

            {/* Clear */}
            <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={onClear}
                title="Clear log display"
            >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
            </Button>
        </div>
    );
});
