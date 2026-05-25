// LarvaeMeasurementTable — sortable, virtualised after 100 rows.
//
// Bidirectional selection link with the polygon layer:
//   - clicking a row notifies the parent (which highlights the polygon)
//   - when `selectedDetectionId` changes externally, the table scrolls the
//     matching row into view.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { cn } from '@/lib/utils';

import type { LarvaeMeasurement, StoredLarvaeAnnotation } from '@/types/api';

interface LarvaeMeasurementTableProps {
    detections: StoredLarvaeAnnotation[];
    measurements: LarvaeMeasurement[];
    selectedDetectionId: string | null;
    onSelect: (detectionId: string | null) => void;
    className?: string;
}

type SortKey = 'index' | 'length_mm' | 'max_width_mm' | 'area_mm2';
type SortDir = 'asc' | 'desc';

const VIRTUALIZE_THRESHOLD = 100;
const ROW_HEIGHT = 36;

export function LarvaeMeasurementTable({
    detections,
    measurements,
    selectedDetectionId,
    onSelect,
    className,
}: LarvaeMeasurementTableProps) {
    const [sortKey, setSortKey] = useState<SortKey>('index');
    const [sortDir, setSortDir] = useState<SortDir>('asc');

    const measurementById = useMemo(() => {
        const map = new Map<string, LarvaeMeasurement>();
        for (const m of measurements) map.set(m.detection_id, m);
        return map;
    }, [measurements]);

    const rows = useMemo(() => {
        const indexed = detections.map((d, i) => ({
            index: i + 1,
            detection: d,
            measurement: measurementById.get(d.detection_id) ?? null,
        }));
        const compareNum = (a: number | null | undefined, b: number | null | undefined) => {
            if (a == null && b == null) return 0;
            if (a == null) return 1; // missing values sink
            if (b == null) return -1;
            return a - b;
        };
        const cmp = (a: (typeof indexed)[number], b: (typeof indexed)[number]) => {
            if (sortKey === 'index') return a.index - b.index;
            const av = a.measurement?.[sortKey] ?? null;
            const bv = b.measurement?.[sortKey] ?? null;
            return compareNum(av, bv);
        };
        const sorted = [...indexed].sort((a, b) => {
            const r = cmp(a, b);
            return sortDir === 'asc' ? r : -r;
        });
        return sorted;
    }, [detections, measurementById, sortKey, sortDir]);

    const virtualize = rows.length > VIRTUALIZE_THRESHOLD;
    const parentRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: virtualize ? rows.length : 0,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 8,
    });

    // External → internal selection: scroll into view when the parent picks
    // a row (e.g. by clicking a polygon).
    useEffect(() => {
        if (!selectedDetectionId) return;
        const idx = rows.findIndex(
            (r) => r.detection.detection_id === selectedDetectionId,
        );
        if (idx < 0) return;
        if (virtualize) {
            virtualizer.scrollToIndex(idx, { align: 'center' });
        } else {
            const el = parentRef.current?.querySelector<HTMLElement>(
                `[data-row-id="${selectedDetectionId}"]`,
            );
            // jsdom doesn't implement scrollIntoView; gate it.
            el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
    }, [selectedDetectionId, rows, virtualize, virtualizer]);

    function toggleSort(key: SortKey) {
        if (sortKey === key) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir('asc');
        }
    }

    function fmt(v: number | null | undefined, digits = 2): string {
        if (v == null) return '—';
        return v.toFixed(digits);
    }

    function renderRow(
        row: (typeof rows)[number],
        style?: React.CSSProperties,
    ) {
        const isSelected = row.detection.detection_id === selectedDetectionId;
        return (
            <div
                key={row.detection.detection_id}
                data-row-id={row.detection.detection_id}
                style={style}
                role="row"
                tabIndex={0}
                aria-selected={isSelected}
                className={cn(
                    'grid cursor-pointer grid-cols-[3rem_1fr_1fr_1fr] items-center gap-2 border-b border-border/60 px-3 text-sm hover:bg-muted/40',
                    isSelected && 'bg-primary/10',
                )}
                onClick={() => onSelect(row.detection.detection_id)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(row.detection.detection_id);
                    }
                }}
            >
                <span className="text-muted-foreground tabular-nums">
                    #{row.index}
                </span>
                <span className="tabular-nums">{fmt(row.measurement?.length_mm)}</span>
                <span className="tabular-nums">{fmt(row.measurement?.max_width_mm)}</span>
                <span className="tabular-nums">{fmt(row.measurement?.area_mm2)}</span>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'flex h-full flex-col overflow-hidden rounded-md border bg-card text-card-foreground',
                className,
            )}
            data-testid="larvae-measurement-table"
        >
            <div
                role="row"
                className="grid grid-cols-[3rem_1fr_1fr_1fr] items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
            >
                <SortableHeader
                    label="#"
                    active={sortKey === 'index'}
                    dir={sortDir}
                    onClick={() => toggleSort('index')}
                />
                <SortableHeader
                    label="Length (mm)"
                    active={sortKey === 'length_mm'}
                    dir={sortDir}
                    onClick={() => toggleSort('length_mm')}
                />
                <SortableHeader
                    label="Max W (mm)"
                    active={sortKey === 'max_width_mm'}
                    dir={sortDir}
                    onClick={() => toggleSort('max_width_mm')}
                />
                <SortableHeader
                    label="Area (mm²)"
                    active={sortKey === 'area_mm2'}
                    dir={sortDir}
                    onClick={() => toggleSort('area_mm2')}
                />
            </div>
            <div
                ref={parentRef}
                role="rowgroup"
                className="flex-1 overflow-auto"
                style={virtualize ? { contain: 'strict' } : undefined}
            >
                {virtualize ? (
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            position: 'relative',
                            width: '100%',
                        }}
                    >
                        {virtualizer.getVirtualItems().map((vrow) => {
                            const row = rows[vrow.index];
                            return renderRow(row, {
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                transform: `translateY(${vrow.start}px)`,
                                height: ROW_HEIGHT,
                            });
                        })}
                    </div>
                ) : (
                    rows.map((row) => renderRow(row))
                )}
                {rows.length === 0 && (
                    <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
                        No detections.
                    </div>
                )}
            </div>
        </div>
    );
}

function SortableHeader({
    label,
    active,
    dir,
    onClick,
}: {
    label: string;
    active: boolean;
    dir: SortDir;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex items-center gap-1 text-left',
                active && 'text-foreground',
            )}
        >
            {label}
            {active && <span aria-hidden>{dir === 'asc' ? '▲' : '▼'}</span>}
        </button>
    );
}
