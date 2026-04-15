// SearchFilters — search bar, organism filter, sort controls.
// Composed inside the Recorded page header.

import { useCallback } from "react";
import { Search, X, ArrowDown, ArrowUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RecordedFilters, SortKey } from "../hooks/useRecorded";
import type { Organism } from "@/types/api";

interface SearchFiltersProps {
  filters: RecordedFilters;
  onFiltersChange: (updates: Partial<RecordedFilters>) => void;
  total: number;
}

const ORGANISM_OPTIONS: { value: Organism | "all"; label: string }[] = [
  { value: "all", label: "All organisms" },
  { value: "egg", label: "Egg" },
  { value: "larvae", label: "Larvae" },
  { value: "pupae", label: "Pupae" },
  { value: "neonate", label: "Neonate" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "created_at", label: "Date" },
  { value: "total_count", label: "Egg count" },
];

export function SearchFilters({ filters, onFiltersChange, total }: SearchFiltersProps) {
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onFiltersChange({ q: e.target.value });
    },
    [onFiltersChange]
  );

  const clearSearch = useCallback(() => {
    onFiltersChange({ q: "" });
  }, [onFiltersChange]);

  const toggleSortDir = useCallback(() => {
    onFiltersChange({ sortDir: filters.sortDir === "desc" ? "asc" : "desc" });
  }, [filters.sortDir, onFiltersChange]);

  const hasActiveFilters = filters.q !== "" || filters.organism !== "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative min-w-52 flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by filename…"
            value={filters.q}
            onChange={handleSearchChange}
            className="pl-9 pr-8 h-9"
          />
          {filters.q && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Organism filter */}
        <Select
          value={filters.organism || "all"}
          onValueChange={(val) =>
            onFiltersChange({ organism: val === "all" ? "" : (val as Organism) })
          }
        >
          <SelectTrigger className={cn("w-40 h-9", filters.organism && "border-primary/60 text-primary")}>
            <SelectValue placeholder="Organism" />
          </SelectTrigger>
          <SelectContent>
            {ORGANISM_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Sort by */}
        <Select
          value={filters.sortKey}
          onValueChange={(val) => onFiltersChange({ sortKey: val as SortKey })}
        >
          <SelectTrigger className="w-36 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                Sort by {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Sort direction toggle */}
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 px-3"
          onClick={toggleSortDir}
          title={filters.sortDir === "desc" ? "Newest first — click for oldest first" : "Oldest first — click for newest first"}
        >
          {filters.sortDir === "desc" ? (
            <ArrowDown className="h-3.5 w-3.5" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" />
          )}
          <span className="text-xs">{filters.sortDir === "desc" ? "Newest" : "Oldest"}</span>
        </Button>

        {/* Clear filters */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-muted-foreground hover:text-foreground"
            onClick={() => onFiltersChange({ q: "", organism: "" })}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        )}

        {/* Result count */}
        <Badge variant="secondary" className="ml-auto h-6 text-xs tabular-nums">
          {total.toLocaleString()} batch{total !== 1 ? "es" : ""}
        </Badge>
      </div>
    </div>
  );
}
