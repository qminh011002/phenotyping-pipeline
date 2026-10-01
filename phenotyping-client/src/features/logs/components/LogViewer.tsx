// LogViewer — scrollable log display with live WebSocket stream.
// Composed of LogFilterBar (controls) + log entry list.

import { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ListFilter, Terminal, WifiOff, type LucideIcon } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { LogFilterBar } from './LogFilterBar';
import { LogEntryRow } from './LogEntry';
import { useLogs } from '../hooks/useLogs';

const AUTO_SCROLL_THRESHOLD = 60; // px from top to consider "at live edge"

function LogPlaceholder({
    icon: Icon,
    title,
    description,
}: {
    icon: LucideIcon;
    title: string;
    description: string;
}) {
    return (
        <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                <Icon className="size-5" aria-hidden />
            </div>
            <p className="text-sm font-semibold">{title}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
        </div>
    );
}

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

    // Resuming from the toolbar jumps back to the live edge, so follow mode
    // actually picks up again instead of waiting for a manual scroll to the top.
    const handleAutoScroll = useCallback(
        (next: boolean) => {
            setAutoScroll(next);
            if (next) scrollRef.current?.scrollTo({ top: 0 });
        },
        [setAutoScroll],
    );

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
                onAutoScroll={handleAutoScroll}
            />

            {/* Log list */}
            <ScrollArea className="min-h-0 flex-1" ref={scrollRef}>
                {filteredLogs.length === 0 ? (
                    wsStatus === 'disconnected' ? (
                        <LogPlaceholder
                            icon={WifiOff}
                            title="Connection lost"
                            description="The log stream disconnected. Reconnecting automatically…"
                        />
                    ) : allLogs.length > 0 ? (
                        <LogPlaceholder
                            icon={ListFilter}
                            title="No entries match the selected levels"
                            description="Turn a level back on in the toolbar to see its entries."
                        />
                    ) : (
                        <LogPlaceholder
                            icon={Terminal}
                            title="Waiting for logs…"
                            description="New entries appear here as the backend writes them."
                        />
                    )
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
                                    className="absolute top-0 left-0 w-full"
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
