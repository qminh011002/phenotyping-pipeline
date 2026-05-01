// LogViewer — scrollable log display with live WebSocket stream.
// Composed of LogFilterBar (controls) + log entry list.

import { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { WifiOff } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { LogFilterBar } from './LogFilterBar';
import { LogEntryRow } from './LogEntry';
import { useLogs } from '../hooks/useLogs';

const AUTO_SCROLL_THRESHOLD = 60; // px from top to consider "at live edge"

export function LogViewer() {
    const {
        logs: allLogs,
        filteredLogs,
        filters,
        wsStatus,
        autoScroll,
        setAutoScroll,
        toggleFilter,
        clearLogs,
    } = useLogs();

    const scrollRef = useRef<HTMLDivElement>(null);
    const rowVirtualizer = useVirtualizer({
        count: filteredLogs.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 28,
        overscan: 16,
    });

    const isAtLiveEdge = useCallback(() => {
        const vp = scrollRef.current;
        if (!vp) return true;
        return vp.scrollTop < AUTO_SCROLL_THRESHOLD;
    }, []);

    // Keep the newest log visible when follow mode is enabled.
    useEffect(() => {
        if (autoScroll && isAtLiveEdge()) {
            rowVirtualizer.scrollToIndex(0, { align: 'start' });
        }
    }, [filteredLogs.length, autoScroll, isAtLiveEdge, rowVirtualizer]);

    // Pause follow mode once the user scrolls away from the live edge.
    useEffect(() => {
        const vp = scrollRef.current;
        if (!vp) return;
        const onScroll = () => {
            setAutoScroll(isAtLiveEdge());
        };
        vp.addEventListener('scroll', onScroll, { passive: true });
        return () => vp.removeEventListener('scroll', onScroll);
    }, [isAtLiveEdge, setAutoScroll]);

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {/* Controls */}
            <LogFilterBar
                filters={filters}
                wsStatus={wsStatus}
                autoScroll={autoScroll}
                filteredCount={filteredLogs.length}
                totalCount={allLogs.length}
                onToggle={toggleFilter}
                onClear={clearLogs}
                onAutoScroll={setAutoScroll}
            />

            {/* Log list */}
            <ScrollArea className="min-h-0 flex-1" ref={scrollRef}>
                {filteredLogs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-16 text-center gap-3">
                        {wsStatus === 'disconnected' ? (
                            <>
                                <WifiOff className="h-8 w-8 text-muted-foreground" />
                                <p className="text-base font-medium">Connection lost</p>
                                <p className="text-sm text-muted-foreground">
                                    The log stream disconnected. Reconnecting automatically…
                                </p>
                            </>
                        ) : (
                            <>
                                <Skeleton className="h-4 w-40" />
                                <p className="text-sm text-muted-foreground">Waiting for logs…</p>
                            </>
                        )}
                    </div>
                ) : (
                    <div
                        className="relative py-1"
                        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                    >
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const entry = filteredLogs[virtualRow.index];
                            return (
                                <div
                                    key={virtualRow.key}
                                    ref={rowVirtualizer.measureElement}
                                    data-index={virtualRow.index}
                                    className="absolute left-0 top-0 w-full"
                                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    <LogEntryRow entry={entry} />
                                </div>
                            );
                        })}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
}
