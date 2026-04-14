// ConnectionSection — backend URL editor and liveness status.
// Calls GET /health to verify connectivity and shows key health fields.

import { useState, useCallback, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { getHealth } from "@/services/api";
import { getBaseUrl, setBaseUrl } from "@/services/http";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Wifi,
  WifiOff,
  RefreshCw,
  Cpu,
  Gauge,
  Tag,
} from "lucide-react";
import type { HealthResponse } from "@/types/api";

type ConnStatus = "idle" | "checking" | "connected" | "error";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ConnectionSection() {
  const [url, setUrl] = useState(() => getBaseUrl());
  const [status, setStatus] = useState<ConnStatus>("idle");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Auto-check on mount
  useEffect(() => {
    testConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const testConnection = useCallback(async () => {
    setStatus("checking");
    setErrorMsg(null);
    try {
      const data = await getHealth() as HealthResponse;
      setHealth(data);
      setStatus("connected");
    } catch (err) {
      setHealth(null);
      setStatus("error");
      setErrorMsg(String(err));
    }
  }, []);

  const applyUrl = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("Backend URL cannot be empty");
      return;
    }
    try {
      new URL(trimmed);
    } catch {
      toast.error("Invalid URL format");
      return;
    }
    setBaseUrl(trimmed);
    toast.success("Backend URL updated. Run \"Test Connection\" to verify.");
    testConnection();
  }, [url, testConnection]);

  const isConnected = status === "connected";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backend Connection</CardTitle>
        <CardDescription>
          Configure the backend server address and verify connectivity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* URL editor row */}
        <div className="space-y-2">
          <Label htmlFor="backend-url">Backend URL</Label>
          <div className="flex gap-2">
            <Input
              id="backend-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:8000"
              className="font-mono text-sm"
            />
            <Button onClick={applyUrl} variant="outline">
              Apply
            </Button>
          </div>
        </div>

        {/* Test + status row */}
        <div className="flex items-center gap-4">
          <Button
            onClick={testConnection}
            variant="default"
            size="sm"
            disabled={status === "checking"}
            className="gap-2"
          >
            {status === "checking" ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Test Connection
          </Button>

          {status === "connected" && health && (
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <Wifi className="h-4 w-4" />
              <span>Connected</span>
            </div>
          )}

          {status === "error" && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <WifiOff className="h-4 w-4" />
              <span>{errorMsg ?? "Connection failed"}</span>
            </div>
          )}
        </div>

        {/* Health info */}
        {(isConnected && health) || status === "checking" ? (
          <div className="rounded-md border bg-muted/40 p-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Backend Health
            </p>
            {status === "checking" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-32" />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-2 text-sm">
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Device</span>
                  <span className="ml-auto font-mono">{health!.device}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">CUDA available</span>
                  <span className={cn(
                    "ml-auto font-medium",
                    health!.cuda_available ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
                  )}>
                    {health!.cuda_available ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Model loaded</span>
                  <span className={cn(
                    "ml-auto font-medium",
                    health!.model_loaded ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400"
                  )}>
                    {health!.model_loaded ? "Yes" : "Loading…"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Version</span>
                  <span className="ml-auto font-mono text-xs">{health!.version}</span>
                </div>
                <div className="flex items-center gap-2 text-sm sm:col-span-2">
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Uptime</span>
                  <span className="ml-auto font-mono">{formatUptime(health!.uptime_seconds)}</span>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
