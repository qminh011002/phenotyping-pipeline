import { ArrowLeft, Download, Eye, Pencil, Save } from "lucide-react";

import { InlineEditableText } from "@/components/common/InlineEditableText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DetectionResult } from "@/types/api";

import { ResultNavigation } from "./ResultNavigation";

interface BatchDetailLike {
  id: string;
  name: string;
}

interface BatchSummaryLike {
  total_count: number;
  total_elapsed_seconds: number;
}

interface ResultViewerHeaderProps {
  batchDetail: BatchDetailLike | null;
  batchSummary: BatchSummaryLike | null;
  currentIndex: number;
  currentResult: DetectionResult;
  results: DetectionResult[];
  canEdit: boolean;
  editMode: boolean;
  isDirty: boolean;
  onBack: () => void;
  onNavigate: (index: number) => void;
  onRename: (next: string) => Promise<void>;
  onSaveToRecords: () => void;
  onDownload: () => void;
}

export function ResultViewerHeader({
  batchDetail,
  batchSummary,
  currentIndex,
  currentResult,
  results,
  canEdit,
  editMode,
  isDirty,
  onBack,
  onNavigate,
  onRename,
  onSaveToRecords,
  onDownload,
}: ResultViewerHeaderProps) {
  const isBatch = results.length > 1;

  return (
    <header className="bg-card flex items-center justify-between border-b px-6 py-3">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          title="Back to home"
          className="h-8 w-8"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        {batchDetail ? (
          <h1 className="text-lg font-semibold">
            <InlineEditableText
              value={batchDetail.name}
              onSave={onRename}
              ariaLabel="Rename batch"
            />
          </h1>
        ) : (
          <h1 className="text-lg font-semibold">{currentResult.filename}</h1>
        )}

        {isBatch && (
          <>
            <ResultNavigation
              results={results}
              currentIndex={currentIndex}
              onNavigate={onNavigate}
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

        {canEdit &&
          (editMode ? (
            <Badge
              variant="default"
              className="ml-2 gap-1 bg-blue-600 hover:bg-blue-600/90"
            >
              <Pencil className="h-3 w-3" />
              Reviewing
              {isDirty && <span className="ml-0.5">•</span>}
            </Badge>
          ) : (
            <Badge variant="secondary" className="ml-2 gap-1">
              <Eye className="h-3 w-3" />
              View
            </Badge>
          ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onSaveToRecords}
          className="gap-2"
        >
          <Save className="h-4 w-4" />
          Save to Records
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onDownload}
          className="gap-2"
        >
          <Download className="h-4 w-4" />
          Download
        </Button>
      </div>
    </header>
  );
}
