// ResultNavigation — prev/next navigation for batch results with keyboard support.

import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DetectionResult } from "@/types/api";

interface ResultNavigationProps {
  results: DetectionResult[];
  currentIndex: number;
  onNavigate: (index: number) => void;
}

export function ResultNavigation({
  results,
  currentIndex,
  onNavigate,
}: ResultNavigationProps) {
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < results.length - 1;

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft" && hasPrev) onNavigate(currentIndex - 1);
      if (e.key === "ArrowRight" && hasNext) onNavigate(currentIndex + 1);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentIndex, hasPrev, hasNext, onNavigate]);

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="icon"
        disabled={!hasPrev}
        onClick={() => onNavigate(currentIndex - 1)}
        title="Previous (←)"
        className="h-8 w-8"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <span className="text-sm tabular-nums font-medium">
        Image{" "}
        <span className="font-mono">{currentIndex + 1}</span>
        {" "}of{" "}
        <span className="font-mono">{results.length}</span>
      </span>

      <Button
        variant="outline"
        size="icon"
        disabled={!hasNext}
        onClick={() => onNavigate(currentIndex + 1)}
        title="Next (→)"
        className="h-8 w-8"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
