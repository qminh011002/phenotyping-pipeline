// SearchFilters — the toolbar under the Recorded page title: search, status
// and organism filters, sort controls, the result count and the grid / list
// switch.

import { ArrowDown, ArrowUp, LayoutGrid, List, Search, X } from 'lucide-react';

import { SegmentedControl, type SegmentedOption } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { formatCount, pluralize } from '@/lib/format';
import { ORGANISM_ORDER, organismMeta } from '@/lib/organism';
import type { Organism } from '@/types/api';
import type { RecordedFilters, SortDir, SortKey, StatusFilter } from '../hooks/useRecorded';
import type { BatchLayout } from './BatchCard';

interface SearchFiltersProps {
    filters: RecordedFilters;
    onFiltersChange: (updates: Partial<RecordedFilters>) => void;
    /** Resets search, organism and status (sort is kept). */
    onClear: () => void;
    hasActiveFilters: boolean;
    total: number;
    /** Hide the count until the first page has loaded. */
    loading?: boolean;
    layout: BatchLayout;
    onLayoutChange: (layout: BatchLayout) => void;
}

const STATUS_OPTIONS: SegmentedOption<StatusFilter>[] = [
    { value: 'all', label: 'All', title: 'Saved, draft and failed batches' },
    { value: 'completed', label: 'Saved', title: 'Reviewed and saved' },
    { value: 'draft', label: 'Drafts', title: 'Processed — waiting for review' },
    { value: 'failed', label: 'Failed', title: 'Processing did not finish' },
];

const LAYOUT_OPTIONS: SegmentedOption<BatchLayout>[] = [
    {
        value: 'grid',
        title: 'Grid',
        label: (
            <>
                <LayoutGrid className="size-3.5" aria-hidden />
                <span className="sr-only">Grid</span>
            </>
        ),
    },
    {
        value: 'list',
        title: 'List',
        label: (
            <>
                <List className="size-3.5" aria-hidden />
                <span className="sr-only">List</span>
            </>
        ),
    },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
    { value: 'created_at', label: 'Date' },
    { value: 'total_count', label: 'Count' },
];

// What each direction means for each sort key, and what a click switches to.
const SORT_DIR_LABEL: Record<SortKey, Record<SortDir, string>> = {
    created_at: { desc: 'Newest', asc: 'Oldest' },
    total_count: { desc: 'Highest', asc: 'Lowest' },
};

export function SearchFilters({
    filters,
    onFiltersChange,
    onClear,
    hasActiveFilters,
    total,
    loading = false,
    layout,
    onLayoutChange,
}: SearchFiltersProps) {
    const dirLabels = SORT_DIR_LABEL[filters.sortKey];
    const nextDir: SortDir = filters.sortDir === 'desc' ? 'asc' : 'desc';
    const DirIcon = filters.sortDir === 'desc' ? ArrowDown : ArrowUp;

    return (
        <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative min-w-52 max-w-sm flex-1">
                <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                />
                <Input
                    type="search"
                    placeholder="Search name or filename…"
                    aria-label="Search batches by name or filename"
                    value={filters.q}
                    onChange={(e) => onFiltersChange({ q: e.target.value })}
                    className="h-8 rounded-md pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
                />
                {filters.q && (
                    <button
                        type="button"
                        onClick={() => onFiltersChange({ q: '' })}
                        className="absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        aria-label="Clear search"
                    >
                        <X className="size-3.5" aria-hidden />
                    </button>
                )}
            </div>

            {/* Status */}
            <SegmentedControl
                aria-label="Filter by status"
                value={filters.status}
                onChange={(status) => onFiltersChange({ status })}
                options={STATUS_OPTIONS}
            />

            {/* Organism */}
            <Select
                value={filters.organism || 'all'}
                onValueChange={(val) =>
                    onFiltersChange({ organism: val === 'all' ? '' : (val as Organism) })
                }
            >
                <SelectTrigger size="sm" className="w-40" aria-label="Filter by organism">
                    <SelectValue placeholder="Organism" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">All organisms</SelectItem>
                    {ORGANISM_ORDER.map((id) => {
                        const meta = organismMeta(id);
                        return (
                            <SelectItem key={id} value={id}>
                                <span
                                    aria-hidden
                                    className="size-1.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: meta.color }}
                                />
                                {meta.label}
                            </SelectItem>
                        );
                    })}
                </SelectContent>
            </Select>

            {/* Sort key */}
            <Select
                value={filters.sortKey}
                onValueChange={(val) => onFiltersChange({ sortKey: val as SortKey })}
            >
                <SelectTrigger size="sm" className="w-36" aria-label="Sort by">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {SORT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                            Sort by {opt.label.toLowerCase()}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* Sort direction */}
            <Button
                variant="outline"
                size="sm"
                onClick={() => onFiltersChange({ sortDir: nextDir })}
                title={`${dirLabels[filters.sortDir]} first — click for ${dirLabels[nextDir].toLowerCase()} first`}
                aria-label={`Sort direction: ${dirLabels[filters.sortDir].toLowerCase()} first`}
            >
                <DirIcon aria-hidden />
                {dirLabels[filters.sortDir]}
            </Button>

            {/* Clear filters */}
            {hasActiveFilters && (
                <Button variant="secondary" size="sm" onClick={onClear}>
                    <X aria-hidden />
                    Clear
                </Button>
            )}

            {/* Result count */}
            <span
                className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground"
                aria-live="polite"
            >
                <span className="font-medium tabular-nums text-foreground">
                    {loading ? '—' : formatCount(total)}
                </span>
                {pluralize(total, 'batch', 'batches')}
            </span>

            {/* Layout */}
            <SegmentedControl
                aria-label="Layout"
                value={layout}
                onChange={onLayoutChange}
                options={LAYOUT_OPTIONS}
            />
        </div>
    );
}
