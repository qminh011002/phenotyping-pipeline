// Filmstrip — every image of the batch as a thumbnail along the bottom of
// the viewer, with its count. Jumping between images is one click instead of
// stepping through prev / next. Thumbnails load lazily as they scroll in.

import { memo, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Images } from 'lucide-react';

import { Thumbnail } from '@/components/common';
import { getThumbnailUrl } from '@/services/api';
import { cn } from '@/lib/utils';

export interface FilmstripItem {
    imageId: string;
    filename: string;
    /** Detections on the image; null while unknown. */
    count: number | null;
    /** Needs the user's attention (e.g. no calibration, stale measurements). */
    flagged?: boolean;
    /** Why it is flagged — tooltip text. */
    flagReason?: string;
}

interface FilmstripProps {
    batchId: string;
    items: FilmstripItem[];
    currentIndex: number;
    onNavigate: (index: number) => void;
    collapsed: boolean;
    onToggleCollapsed: () => void;
    className?: string;
}

const FilmstripTile = memo(function FilmstripTile({
    batchId,
    item,
    index,
    active,
    onNavigate,
}: {
    batchId: string;
    item: FilmstripItem;
    index: number;
    active: boolean;
    onNavigate: (index: number) => void;
}) {
    return (
        <button
            type="button"
            data-filmstrip-index={index}
            onClick={() => onNavigate(index)}
            aria-current={active ? 'true' : undefined}
            aria-label={`Image ${index + 1}: ${item.filename}${
                item.count != null ? `, ${item.count} detections` : ''
            }`}
            title={
                item.flagged && item.flagReason
                    ? `${item.filename} — ${item.flagReason}`
                    : item.filename
            }
            className={cn(
                'group relative h-14 w-20 shrink-0 overflow-hidden rounded-md outline-none transition-[box-shadow,opacity] duration-150',
                'focus-visible:ring-2 focus-visible:ring-ring',
                active
                    ? 'ring-2 ring-primary ring-offset-2 ring-offset-card'
                    : 'opacity-70 ring-1 ring-border hover:opacity-100',
            )}
        >
            <Thumbnail
                src={getThumbnailUrl(batchId, item.imageId, 'raw', 160)}
                alt=""
                className="h-full w-full"
            />
            <span className="absolute left-1 top-1 rounded-sm bg-black/60 px-1 font-mono text-[9px] font-medium leading-4 text-white/90 tabular-nums">
                {index + 1}
            </span>
            {item.count != null && (
                <span className="absolute bottom-1 right-1 rounded-sm bg-black/70 px-1 font-mono text-[10px] font-semibold leading-4 text-white tabular-nums">
                    {item.count.toLocaleString()}
                </span>
            )}
            {item.flagged && (
                <span
                    aria-hidden
                    className="absolute right-1 top-1 size-2 rounded-full bg-warning ring-2 ring-black/40"
                />
            )}
        </button>
    );
});

export function Filmstrip({
    batchId,
    items,
    currentIndex,
    onNavigate,
    collapsed,
    onToggleCollapsed,
    className,
}: FilmstripProps) {
    const scrollerRef = useRef<HTMLDivElement>(null);

    // Keep the current image's tile on screen as the user steps through.
    useEffect(() => {
        if (collapsed) return;
        const el = scrollerRef.current?.querySelector<HTMLElement>(
            `[data-filmstrip-index="${currentIndex}"]`,
        );
        el?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }, [currentIndex, collapsed]);

    if (items.length <= 1) return null;

    const total = items.reduce((sum, item) => sum + (item.count ?? 0), 0);

    return (
        <div className={cn('shrink-0 border-t border-border bg-card', className)}>
            <button
                type="button"
                onClick={onToggleCollapsed}
                aria-expanded={!collapsed}
                className="flex h-7 w-full items-center gap-2 px-3 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:bg-muted"
            >
                <Images className="size-3.5" aria-hidden />
                <span>
                    {items.length} images
                    <span className="mx-1.5 text-border">·</span>
                    <span className="font-mono tabular-nums">{total.toLocaleString()}</span> counted
                    in this batch
                </span>
                <span className="ml-auto flex items-center gap-1">
                    {collapsed ? 'Show' : 'Hide'}
                    {collapsed ? (
                        <ChevronUp className="size-3.5" aria-hidden />
                    ) : (
                        <ChevronDown className="size-3.5" aria-hidden />
                    )}
                </span>
            </button>
            {!collapsed && (
                <div
                    ref={scrollerRef}
                    className="flex gap-2 overflow-x-auto px-3 pb-2.5 pt-1.5"
                    // Wheel scrolls the strip sideways.
                    onWheel={(e) => {
                        if (e.deltaY !== 0 && e.deltaX === 0) {
                            e.currentTarget.scrollLeft += e.deltaY;
                        }
                    }}
                >
                    {items.map((item, index) => (
                        <FilmstripTile
                            key={item.imageId}
                            batchId={batchId}
                            item={item}
                            index={index}
                            active={index === currentIndex}
                            onNavigate={onNavigate}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
