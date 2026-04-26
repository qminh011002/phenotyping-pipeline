import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Upload, Bug } from "lucide-react";
import type { OrganismAssignment, Organism } from "@/types/api";

const ORGANISM_LABELS: Record<Organism, string> = {
  egg: "Egg",
  larvae: "Larvae",
  pupae: "Pupae",
  neonate: "Neonate",
};

interface ModelSlotCardProps {
  assignment: OrganismAssignment;
  onReplace: (organism: Organism) => void;
  onRevert: (organism: Organism) => void;
  reverting?: boolean;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ModelSlotCard({
  assignment,
  onReplace,
  onRevert,
  reverting,
}: ModelSlotCardProps) {
  const { organism, is_default, has_default, model_filename, custom_model } = assignment;
  const slotMissing = custom_model === null && !has_default;

  return (
    <div className="flex items-start justify-between rounded-lg border p-4">
      <div className="space-y-1.5 min-w-0">
        <div className="flex items-center gap-2">
          <Bug className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium">
            {ORGANISM_LABELS[organism as Organism] ?? organism}
          </span>
          {slotMissing ? (
            <Badge variant="destructive">Not installed</Badge>
          ) : (
            <Badge variant={is_default ? "secondary" : "default"}>
              {is_default ? "Default" : "Custom"}
            </Badge>
          )}
        </div>

        <p className="font-mono text-sm text-muted-foreground truncate">
          {model_filename ?? "—"}
        </p>

        {custom_model && (
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>{formatSize(custom_model.file_size_bytes)}</span>
            <span>{formatDate(custom_model.uploaded_at)}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 shrink-0 ml-4">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => onReplace(organism as Organism)}
        >
          <Upload className="h-3.5 w-3.5" />
          Replace
        </Button>
        {!is_default && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => onRevert(organism as Organism)}
            disabled={reverting}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {reverting ? "Reverting…" : "Revert"}
          </Button>
        )}
      </div>
    </div>
  );
}
