// DeviceSection — CPU/GPU inference device selector.
// Reads the current device from GET /config and saves via PUT /config.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/common/ErrorState";
import { getConfig, updateConfig } from "@/services/api";
import { getHealth } from "@/services/api";
import { toast } from "sonner";
import { Cpu, Gauge, AlertCircle } from "lucide-react";
import type { EggConfig, Device } from "@/types/api";

export function DeviceSection() {
  const [config, setConfig] = useState<EggConfig | null>(null);
  const [cudaAvailable, setCudaAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasHealth, setHasHealth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fetchConfig() {
    setLoading(true);
    setError(null);
    Promise.all([getConfig(), getHealth().catch(() => null)])
      .then(([cfg, health]) => {
        setConfig(cfg);
        setCudaAvailable(health?.cuda_available ?? false);
        setHasHealth(!!health);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleDeviceChange = useCallback((value: string) => {
    setConfig((prev) => prev ? { ...prev, device: value as Device } : prev);
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await updateConfig({ device: config.device });
      setConfig(updated);
      toast.success("Device updated", {
        description: `Inference will use ${config.device}`,
      });
    } catch (err) {
      toast.error("Failed to update device", { description: String(err) });
    } finally {
      setSaving(false);
    }
  }, [config]);

  const isCpu = config?.device === "cpu";

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Inference Device</h2>
        <p className="text-sm text-muted-foreground">
          Choose whether to run the egg-detection model on CPU or an NVIDIA GPU (CUDA).
        </p>
      </div>
      <div className="space-y-5">
        {error !== null ? (
          <ErrorState
            message={error}
            title="Failed to load device settings"
            onRetry={fetchConfig}
          />
        ) : loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : (
          <>
            {/* CUDA availability notice */}
            {!cudaAvailable && hasHealth && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-700 dark:text-yellow-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  No CUDA device detected. GPU inference is unavailable — CPU will be used
                  regardless of the selection below.
                </span>
              </div>
            )}

            {/* Device selector */}
            <div className="space-y-2">
              <Label htmlFor="device-select">Device</Label>
              <Select
                value={config?.device ?? "cpu"}
                onValueChange={handleDeviceChange}
              >
                <SelectTrigger id="device-select" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cpu">
                    <span className="flex items-center gap-2">
                      <Cpu className="h-4 w-4 text-muted-foreground" />
                      CPU
                    </span>
                  </SelectItem>
                  <SelectItem
                    value="cuda:0"
                    disabled={!cudaAvailable}
                  >
                    <span className="flex items-center gap-2">
                      <Gauge className="h-4 w-4 text-muted-foreground" />
                      CUDA (GPU)
                      {!cudaAvailable && (
                        <span className="ml-1 text-xs text-muted-foreground">(unavailable)</span>
                      )}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Save button */}
            <div className="flex items-center gap-3">
              <Button
                onClick={handleSave}
                disabled={saving}
                size="sm"
                className="gap-2"
              >
                {saving ? "Saving…" : "Save Device"}
              </Button>
              {config && (
                <span className="text-sm text-muted-foreground">
                  Currently using: <span className="font-mono">{isCpu ? "CPU" : "CUDA GPU"}</span>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
