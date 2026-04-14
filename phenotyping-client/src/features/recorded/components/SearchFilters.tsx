// SearchFilters — search bar, organism filter, sort control.
// Composed inside the Recorded page header.

import { useCallback } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RecordedFilters, SortKey, SortDir } from "../hooks/useRecorded";
import type { Organism } from "@/types/api";

interface SearchFiltersProps {
  filters: RecordedFilters;
  onFiltersChange: (updates: Partial<RecordedFilters>) => void;
  total: number;
}

const ORGANISM_OPTIONS: { value: Organism | ""; label: string }[] = [
  { value: "", label: "All organisms" },
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

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Search */}
      <div className="relative min-w-52 flex-1 max-w-72">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          placeholder="Search by filename…"
          value={filters.q}
          onChange={handleSearchChange}
          className="pl-9 pr-8"
        />
        {filters.q && (
          <button
            type="button"
            onClick={clearSearch}
            className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer focus:outline-none focus-visible:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Organism filter */}
      <Select
        value={filters.organism}
        onValueChange={(val) => onFiltersChange({ organism: val as Organism | "" })}
      >
        <SelectTrigger className="w-40">
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
        <SelectTrigger className="w-36">
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

      {/* Sort direction */}
      <Select
        value={filters.sortDir}
        onValueChange={(val) => onFiltersChange({ sortDir: val as SortDir })}
      >
        <SelectTrigger className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="desc">Newest first</SelectItem>
          <SelectItem value="asc">Oldest first</SelectItem>
        </SelectContent>
      </Select>

      {/* Result count */}
      <span className="ml-auto text-sm text-muted-foreground">
        {total.toLocaleString()} batch{total !== 1 ? "es" : ""}
      </span>
    </div>
  );
}
