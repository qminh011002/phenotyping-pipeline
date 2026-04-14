// ResultViewer — full page for viewing inference results.
// Supports both single and batch results with overlay image, stat board,
// and navigation.

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Download, ArrowLeft, Save } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { OverlayImage } from "./OverlayImage";
import { StatBoard } from "./StatBoard";
import { ResultNavigation } from "./ResultNavigation";
import type { DetectionResult } from "@/types/api";
import {
  loadProcessingResults,
  loadBatchSummary,
  loadBatchDetail,
  loadProcessingConfig,
} from "@/features/upload/lib/processingSession";
import { getAnalysesOverlayUrl } from "@/services/api";
import { cn } from "@/lib/utils";

interface ResultViewerProps {
  /** If provided, renders inline instead of full page */
  className?: string;
}

export function ResultViewer({ className }: ResultViewerProps) {
  const navigate = useNavigate();

  const [results, setResults] = useState<DetectionResult[]>([]);
  const [batchDetail, setBatchDetail] = useState<ReturnType<typeof loadBatchDetail>>(null);
  const [processingConfig, setProcessingConfig] = useState<Record<string, unknown> | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [batchSummary] = useState(() => loadBatchSummary());
  const [loading, setLoading] = useState(true);

  // Load results and batch detail from sessionStorage on mount
  useEffect(() => {
    const stored = loadProcessingResults();
    const storedDetail = loadBatchDetail();
    const storedConfig = loadProcessingConfig();
    if (stored.length === 0) {
      navigate("/", { replace: true });
      return;
    }
    setResults(stored.map((r) => r.result));
    setBatchDetail(storedDetail);
    setProcessingConfig(storedConfig);
    setLoading(false);
  }, [navigate]);

  const currentResult = results[currentIndex] ?? null;

  // Build absolute overlay URL using the recorded analyses endpoint.
  // We match the current filename to the stored image record to get the UUID.
  const overlaySrc = (() => {
    if (!currentResult || !batchDetail) return "";
    const imageRecord = batchDetail.images.find(
      (img) => img.original_filename === currentResult.filename,
    );
    if (!imageRecord || !imageRecord.overlay_path) return "";
    return getAnalysesOverlayUrl(batchDetail.id, imageRecord.id);
  })();

  // ── Navigation ─────────────────────────────────────────────────────────────

  const handleNavigate = useCallback((index: number) => {
    setCurrentIndex(index);
  }, []);

  // ── Download overlay ────────────────────────────────────────────────────────

  async function handleDownload() {
    if (!currentResult) return;
    try {
      const resp = await fetch(overlaySrc);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentResult.filename.replace(/\.[^.]+$/, "")}_overlay.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Download started");
    } catch {
      toast.error("Failed to download overlay image");
    }
  }

  // ── Save to records ─────────────────────────────────────────────────────────

  function handleSaveToRecords() {
    // Batch is already saved to DB by ProcessingPage — navigate to view it in Recorded page
    const detail = loadBatchDetail();
    if (detail) {
      navigate(`/recorded?batch=${detail.id}`);
    } else {
      navigate("/recorded");
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <div className="flex items-center gap-3 text-muted-foreground">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>Loading results…</span>
        </div>
      </div>
    );
  }

  if (!currentResult) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        <EmptyState
          icon={Download}
          title="No results found"
          description="The session data may have expired. Start a new analysis to see results."
          actionLabel="Start New Analysis"
          onAction={() => navigate("/")}
        />
      </div>
    );
  }

  const isBatch = results.length > 1;

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/")}
            title="Back to home"
            className="h-8 w-8"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          {isBatch && (
            <>
              <ResultNavigation
                results={results}
                currentIndex={currentIndex}
                onNavigate={handleNavigate}
              />
              {batchSummary && (
                <span className="ml-4 text-sm text-muted-foreground">
                  <span className="font-mono font-semibold text-foreground">
                    {batchSummary.total_count}
                  </span>{" "}
                  eggs ·{" "}
                  <span className="font-mono">
                    {batchSummary.total_elapsed_seconds.toFixed(1)}s
                  </span>
                </span>
              )}
            </>
          )}

          {!isBatch && (
            <h1 className="text-lg font-semibold">{currentResult.filename}</h1>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveToRecords}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            Save to Records
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Download
          </Button>
        </div>
      </header>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Image viewer — ~70% */}
        <div className="flex-1 overflow-hidden border-r">
          <OverlayImage src={overlaySrc} alt={currentResult.filename} />
        </div>

        {/* Stat board — ~30% */}
        <aside className="w-80 shrink-0 overflow-y-auto bg-card">
          <StatBoard result={currentResult} config={processingConfig} />
        </aside>
      </div>
    </div>
  );
}
