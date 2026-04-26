import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  Check,
  Cpu,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  assignModel,
  deleteCustomModel,
  getModelAssignments,
  listCustomModels,
  uploadCustomModel,
} from "@/services/api";
import type {
  AssignmentsResponse,
  CustomModelResponse,
  Organism,
  OrganismAssignment,
} from "@/types/api";

const ORGANISM_ORDER: Organism[] = ["egg", "larvae", "pupae", "neonate"];

const ORGANISM_META: Record<Organism, { label: string; description: string }> = {
  egg: {
    label: "Egg",
    description: "Primary egg-detection weights used for egg counting workflows.",
  },
  larvae: {
    label: "Larvae",
    description: "Larvae-stage detection weights for larvae-specific runs.",
  },
  pupae: {
    label: "Pupae",
    description: "Pupae-stage detection weights for pupae-specific runs.",
  },
  neonate: {
    label: "Neonate",
    description: "Neonate-stage detection weights for neonate-specific runs.",
  },
};

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

interface ModelLibraryProps {
  assignment: OrganismAssignment;
  customModels: CustomModelResponse[];
  uploadingOrganism: Organism | null;
  actionKey: string | null;
  deleteKey: string | null;
  revertKey: Organism | null;
  onActivate: (organism: Organism, modelId: string) => void;
  onDelete: (modelId: string) => void;
  onRevertDefault: (organism: Organism) => void;
  onUploadFile: (organism: Organism, file: File) => void;
}

function ModelLibrary({
  assignment,
  customModels,
  uploadingOrganism,
  actionKey,
  deleteKey,
  revertKey,
  onActivate,
  onDelete,
  onRevertDefault,
  onUploadFile,
}: ModelLibraryProps) {
  const {
    organism,
    is_default,
    has_default,
    model_filename,
    default_filename,
    custom_model,
  } = assignment;
  const meta = ORGANISM_META[organism];
  const activeCustomId = custom_model?.id ?? null;
  const isUploading = uploadingOrganism === organism;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Active state for the slot header. "missing" means neither a default nor a
  // custom-active model is installed — the inference path will 503 and the
  // AnalyzePage card is disabled.
  const slotState: "custom" | "default" | "missing" =
    custom_model !== null
      ? "custom"
      : has_default
        ? "default"
        : "missing";

  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex flex-col gap-4 border-b border-border/70 px-5 py-5">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/60 text-muted-foreground">
              <Bug className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{meta.label} Mode</h3>
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {slotState === "missing" ? (
              <Badge variant="destructive">No model installed</Badge>
            ) : (
              <Badge variant={is_default ? "secondary" : "default"}>
                {is_default ? "Using default" : "Custom active"}
              </Badge>
            )}
            {model_filename && (
              <span className="rounded-full border border-border/70 bg-muted/50 px-2.5 py-1 font-mono text-muted-foreground">
                {model_filename}
              </span>
            )}
            <span className="text-muted-foreground">
              {customModels.length} custom model{customModels.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-5">
        {has_default && default_filename ? (
          <div
            className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
              is_default ? "border-primary/35 bg-primary/5" : "border-border/70 bg-muted/20"
            }`}
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">{default_filename}</span>
                <Badge variant="secondary">Default</Badge>
                {is_default && (
                  <Badge variant="default" className="gap-1">
                    <Check className="h-3 w-3" />
                    Active
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Loaded from <code className="font-mono">backend/data/models/{organism}/default/</code>.
              </p>
            </div>

            {!is_default && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 self-start sm:self-center"
                onClick={() => onRevertDefault(organism)}
                disabled={revertKey === organism}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {revertKey === organism ? "Reverting..." : "Use Default"}
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              No default model installed for {meta.label.toLowerCase()} mode.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Drop a <code className="font-mono">.pt</code> file into{" "}
              <code className="font-mono">backend/data/models/{organism}/default/</code>{" "}
              and restart the backend, or upload a custom model below.
            </p>
          </div>
        )}

        {customModels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/15 px-4 py-5 text-sm text-muted-foreground">
            No custom `.pt` files uploaded for {meta.label.toLowerCase()} yet.
          </div>
        ) : (
          <div className="space-y-3">
            {customModels.map((model) => {
              const isActive = model.id === activeCustomId;
              const currentActionKey = `${organism}:${model.id}`;

              return (
                <div
                  key={model.id}
                  className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
                    isActive ? "border-primary/35 bg-primary/5" : "border-border/70 bg-background"
                  }`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm">{model.original_filename}</span>
                      <Badge variant="outline">Custom</Badge>
                      {isActive && (
                        <Badge variant="default" className="gap-1">
                          <Check className="h-3 w-3" />
                          Active
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{formatSize(model.file_size_bytes)}</span>
                      <span>{formatDate(model.uploaded_at)}</span>
                    </div>
                  </div>

                  <div className="flex gap-2 self-start sm:self-center">
                    {!isActive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => onActivate(organism, model.id)}
                        disabled={actionKey === currentActionKey}
                      >
                        <Check className="h-3.5 w-3.5" />
                        {actionKey === currentActionKey ? "Activating..." : "Set Active"}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-destructive hover:text-destructive"
                      onClick={() => onDelete(model.id)}
                      disabled={deleteKey === model.id || isActive}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {deleteKey === model.id ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <Button
          variant="outline"
          className="w-full gap-2 border-dashed bg-background hover:bg-accent/30"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          <Upload className="h-4 w-4" />
          {isUploading ? "Uploading..." : "Upload Model"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pt"
          className="hidden"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) {
              onUploadFile(organism, selected);
            }
            e.currentTarget.value = "";
          }}
        />
      </div>
    </section>
  );
}

export function ModelsSection() {
  const [assignments, setAssignments] = useState<AssignmentsResponse | null>(null);
  const [customModels, setCustomModels] = useState<CustomModelResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadingOrganism, setUploadingOrganism] = useState<Organism | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [revertKey, setRevertKey] = useState<Organism | null>(null);

  const mountedRef = useRef(true);
  const fetchData = useCallback(async () => {
    try {
      const [assignData, modelsData] = await Promise.all([
        getModelAssignments(),
        listCustomModels(),
      ]);
      if (!mountedRef.current) return;
      setAssignments(assignData);
      setCustomModels(modelsData.models);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData]);

  const modelsByOrganism = useMemo(() => {
    const groups: Record<Organism, CustomModelResponse[]> = {
      egg: [],
      larvae: [],
      pupae: [],
      neonate: [],
    };

    for (const model of customModels) {
      groups[model.organism].push(model);
    }

    return groups;
  }, [customModels]);

  const handleActivate = useCallback(
    async (organism: Organism, modelId: string) => {
      const key = `${organism}:${modelId}`;
      setActionKey(key);
      try {
        await assignModel(organism, modelId);
        toast.success("Model activated", {
          description: `${ORGANISM_META[organism].label} mode now points to the selected model. Restart the backend to apply changes.`,
        });
        await fetchData();
      } catch (err) {
        toast.error("Failed to activate model", { description: String(err) });
      } finally {
        setActionKey(null);
      }
    },
    [fetchData],
  );

  const handleRevertDefault = useCallback(
    async (organism: Organism) => {
      setRevertKey(organism);
      try {
        await assignModel(organism, null);
        toast.success("Reverted to default model", {
          description: `${ORGANISM_META[organism].label} mode will use its built-in default after backend restart.`,
        });
        await fetchData();
      } catch (err) {
        toast.error("Failed to revert model", { description: String(err) });
      } finally {
        setRevertKey(null);
      }
    },
    [fetchData],
  );

  const handleDelete = useCallback(
    async (modelId: string) => {
      setDeleteKey(modelId);
      try {
        await deleteCustomModel(modelId);
        toast.success("Model deleted");
        await fetchData();
      } catch (err) {
        toast.error("Failed to delete model", { description: String(err) });
      } finally {
        setDeleteKey(null);
      }
    },
    [fetchData],
  );

  const handleUploadFile = useCallback(
    async (organism: Organism, file: File) => {
      if (!file.name.toLowerCase().endsWith(".pt")) {
        toast.error("Only .pt files are accepted");
        return;
      }

      setUploadingOrganism(organism);
      try {
        await uploadCustomModel(organism, file);
        toast.success("Model uploaded", {
          description: `${file.name} uploaded for ${ORGANISM_META[organism].label} mode.`,
        });
        await fetchData();
      } catch (err) {
        toast.error("Failed to upload model", { description: String(err) });
      } finally {
        setUploadingOrganism(null);
      }
    },
    [fetchData],
  );

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Cpu className="h-4 w-4" />
          Detection Models
        </h2>
        <p className="text-sm text-muted-foreground">
          Manage YOLO detection models (`.pt`) for all 4 configured modes. Each mode keeps
          its own model library and one active model selection.
        </p>
      </div>
      <div className="space-y-4">
        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : assignments ? (
          ORGANISM_ORDER.map((organism) => (
            <ModelLibrary
              key={organism}
              assignment={assignments.assignments[organism]}
              customModels={modelsByOrganism[organism]}
              uploadingOrganism={uploadingOrganism}
              actionKey={actionKey}
              deleteKey={deleteKey}
              revertKey={revertKey}
              onActivate={handleActivate}
              onDelete={handleDelete}
              onRevertDefault={handleRevertDefault}
              onUploadFile={handleUploadFile}
            />
          ))
        ) : null}
      </div>
    </section>
  );
}
