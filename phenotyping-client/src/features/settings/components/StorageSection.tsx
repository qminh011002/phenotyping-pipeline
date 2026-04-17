// StorageSection — image storage path editor with native folder picker.
// Reads image_storage_dir from GET /settings/storage.
// Saves via PUT /settings/storage.

import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { getStorageSettings, updateStorageSettings } from "@/services/api";
import { toast } from "sonner";
import { FolderOpen, Save, HardDrive } from "lucide-react";
import { ApiError } from "@/services/errors";

export function StorageSection() {
  const [path, setPath] = useState("");
  const [originalPath, setOriginalPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getStorageSettings()
      .then((data) => {
        if (!cancelled) {
          setPath(data.image_storage_dir);
          setOriginalPath(data.image_storage_dir);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Select image storage folder",
      });
      if (typeof picked === "string" && picked) {
        setPath(picked);
        setDirty(true);
      }
    } catch {
      toast.error("Could not open folder picker");
    }
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = path.trim();
    if (!trimmed) {
      toast.error("Storage path cannot be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateStorageSettings({ image_storage_dir: trimmed });
      setPath(updated.image_storage_dir);
      setOriginalPath(updated.image_storage_dir);
      setDirty(false);
      toast.success("Storage path saved", {
        description: "Processed overlay images will be saved to the new location.",
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setError(err.message ?? "Invalid path: the directory may not exist or is not writable.");
        toast.error("Invalid path", {
          description: err.message ?? "The directory may not exist or is not writable.",
        });
      } else {
        setError(String(err));
        toast.error("Failed to save storage path", { description: String(err) });
      }
    } finally {
      setSaving(false);
    }
  }, [path]);

  const handleReset = useCallback(() => {
    setPath(originalPath);
    setDirty(false);
    setError(null);
  }, [originalPath]);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <HardDrive className="h-4 w-4" />
          Image Storage
        </h2>
        <p className="text-sm text-muted-foreground">
          Choose where processed overlay images are saved on your computer.
          Only the file path is stored in the database — images are never converted
          to base64 or stored as blobs.
        </p>
      </div>
      <div className="space-y-4">
        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <>
            {/* Path editor */}
            <div className="space-y-2">
              <Label htmlFor="storage-path">Storage folder path</Label>
              <div className="flex gap-2">
                <Input
                  id="storage-path"
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value);
                    setDirty(e.target.value !== originalPath);
                    setError(null);
                  }}
                  placeholder="/path/to/storage"
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  onClick={handleBrowse}
                  className="gap-2 shrink-0"
                >
                  <FolderOpen className="h-4 w-4" />
                  Browse…
                </Button>
              </div>
            </div>

            {/* Inline error */}
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            {/* Save / Reset */}
            <div className="flex items-center gap-3">
              <Button
                onClick={handleSave}
                disabled={saving || !dirty}
                size="sm"
                className="gap-2"
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving…" : "Save Path"}
              </Button>
              {dirty && !saving && (
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  Discard
                </Button>
              )}
            </div>

            {/* Disk usage hint */}
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <strong>Tip:</strong> Processed images are typically 5–15 MB per image
              depending on resolution and detection density.
            </div>
          </>
        )}
      </div>
    </section>
  );
}
