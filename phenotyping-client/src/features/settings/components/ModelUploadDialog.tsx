import { useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Upload, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { uploadCustomModel } from "@/services/api";
import { ApiError } from "@/services/errors";
import type { Organism } from "@/types/api";

const ORGANISM_LABELS: Record<Organism, string> = {
  egg: "Egg",
  larvae: "Larvae",
  pupae: "Pupae",
  neonate: "Neonate",
};

interface ModelUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organism: Organism | null;
  onSuccess: () => void;
}

type UploadState = "idle" | "uploading" | "success" | "error";

export function ModelUploadDialog({
  open,
  onOpenChange,
  organism,
  onSuccess,
}: ModelUploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setFile(null);
    setState("idle");
    setProgress(0);
    setErrorMsg(null);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (!selected) return;
      if (!selected.name.toLowerCase().endsWith(".pt")) {
        toast.error("Only .pt files are accepted");
        return;
      }
      setFile(selected);
      setErrorMsg(null);
      setState("idle");
    },
    [],
  );

  const handleUpload = useCallback(async () => {
    if (!file || !organism) return;

    setState("uploading");
    setProgress(20);
    setErrorMsg(null);

    try {
      setProgress(50);
      await uploadCustomModel(organism, file);
      setProgress(100);

      setState("success");
      toast.success("Model uploaded", {
        description: `${file.name} is ready for ${ORGANISM_LABELS[organism]}.`,
      });
      onSuccess();
    } catch (err) {
      setState("error");
      const msg =
        err instanceof ApiError
          ? err.message ?? "Upload failed"
          : String(err);
      setErrorMsg(msg);
      toast.error("Model upload failed", { description: msg });
    }
  }, [file, onSuccess, organism]);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) reset();
      onOpenChange(open);
    },
    [onOpenChange, reset],
  );

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const slotLabel = organism ? ORGANISM_LABELS[organism] : "Selected";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload {slotLabel} Model</DialogTitle>
          <DialogDescription>
            Upload a YOLO detection model (`.pt`) for the {slotLabel.toLowerCase()} mode.
            After uploading, you can activate it from that mode's model list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* File picker */}
          <div className="space-y-2">
            <Label>Model file (.pt)</Label>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="gap-2 w-full justify-start font-mono text-sm"
                onClick={() => inputRef.current?.click()}
                disabled={state === "uploading"}
              >
                <Upload className="h-4 w-4 shrink-0" />
                {file ? file.name : "Choose .pt file..."}
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".pt"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
            {file && (
              <p className="text-xs text-muted-foreground">
                {formatSize(file.size)}
              </p>
            )}
          </div>

          {/* Progress */}
          {state === "uploading" && (
            <div className="space-y-2">
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground">
                Uploading and validating model...
              </p>
            </div>
          )}

          {/* Success */}
          {state === "success" && (
            <div className="flex items-center gap-2 rounded-md bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Model uploaded successfully. Activate it for {slotLabel.toLowerCase()} when ready.
            </div>
          )}

          {/* Error */}
          {state === "error" && errorMsg && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <XCircle className="h-4 w-4 shrink-0" />
              {errorMsg}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={state === "uploading"}
            >
              {state === "success" ? "Close" : "Cancel"}
            </Button>
            {state !== "success" && (
              <Button
                onClick={handleUpload}
                disabled={!file || !organism || state === "uploading"}
                className="gap-2"
              >
                <Upload className="h-4 w-4" />
                {state === "uploading" ? "Uploading..." : "Upload"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
