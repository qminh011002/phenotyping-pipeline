// Analyze page — 2-step modal for mode + organism type selection.
//
// Flow (from ui-ux-design.mdc):
//   Step 1: Select Mode  (Upload Image ✓ | Camera 📷 Soon)
//   Step 2: Select Type  (Egg ✓ | Neonate Soon | Pupae Soon | Larvae Soon)
//
// Keyboard: arrow keys navigate cards, Enter selects.
//

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, Camera, Microscope, Sprout, Bug, Worm } from "lucide-react";
import { useProcessingStore } from "@/stores/processingStore";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Mode = "upload" | "camera";
type Organism = "egg" | "larvae" | "pupae" | "neonate";

const MODES: { id: Mode; label: string; description: string; icon: React.ElementType; available: boolean }[] = [
  { id: "upload", label: "Upload Images", description: "Select image files from your device", icon: Upload, available: true },
  { id: "camera", label: "Use Camera", description: "Capture images from a connected camera", icon: Camera, available: false },
];

const ORGANISMS: { id: Organism; label: string; icon: React.ElementType; available: boolean }[] = [
  { id: "egg", label: "Egg", icon: Microscope, available: true },
  { id: "neonate", label: "Neonate", icon: Sprout, available: false },
  { id: "pupae", label: "Pupae", icon: Bug, available: false },
  { id: "larvae", label: "Larvae", icon: Worm, available: false },
];

interface SelectionCardProps {
  label: string;
  description?: string;
  icon: React.ElementType;
  available: boolean;
  selected: boolean;
  onSelect: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  tabIndex?: number;
}

function SelectionCard({ label, description, icon: Icon, available, selected, onSelect, onKeyDown, tabIndex }: SelectionCardProps) {
  return (
    <button
      type="button"
      disabled={!available}
      onClick={available ? onSelect : undefined}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      className={cn(
        "relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 p-6 transition-all",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        available
          ? selected
            ? "border-primary bg-primary/5 cursor-pointer"
            : "border-border hover:border-primary/50 hover:bg-accent cursor-pointer"
          : "border-border bg-muted/30 cursor-not-allowed opacity-60",
      )}
      aria-pressed={selected}
      aria-disabled={!available}
    >
      {/* Available badge */}
      {!available && (
        <span className="absolute top-2 right-2 rounded-full bg-muted-foreground/20 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          Soon
        </span>
      )}
      {/* Check mark */}
      {selected && (
        <span className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
      )}
      <Icon className={cn("h-8 w-8", selected ? "text-primary" : "text-muted-foreground")} />
      <span className={cn("text-sm font-medium", selected ? "text-primary" : "text-foreground")}>
        {label}
      </span>
      {description && (
        <span className="text-xs text-muted-foreground text-center">{description}</span>
      )}
    </button>
  );
}

export default function AnalyzePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedMode, setSelectedMode] = useState<Mode | null>(null);
  const [selectedOrganism, setSelectedOrganism] = useState<Organism | null>(null);

  const isProcessing = useProcessingStore((s) => s.isProcessing);

  // Redirect to processing page if a batch is currently running
  useEffect(() => {
    if (isProcessing) {
      navigate("/analyze/processing", { replace: true });
    }
  }, [isProcessing, navigate]);

  // Reset when modal reopens (navigating back)
  useEffect(() => {
    setStep(1);
    setSelectedMode(null);
    setSelectedOrganism(null);
  }, []);

  function handleModeSelect(mode: Mode) {
    setSelectedMode(mode);
  }

  function handleModeKeyDown(e: React.KeyboardEvent, mode: Mode) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (MODES.find(m => m.id === mode)?.available) handleModeSelect(mode);
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = MODES.findIndex(m => m.id === mode) + 1;
      if (next < MODES.length) {
        (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = MODES.findIndex(m => m.id === mode) - 1;
      if (prev >= 0) {
        (e.currentTarget.parentElement?.children[prev] as HTMLElement)?.focus();
      }
    }
  }

  function handleOrganismKeyDown(e: React.KeyboardEvent, organism: Organism) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (ORGANISMS.find(o => o.id === organism)?.available) setSelectedOrganism(organism);
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = ORGANISMS.findIndex(o => o.id === organism) + 1;
      if (next < ORGANISMS.length) {
        (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = ORGANISMS.findIndex(o => o.id === organism) - 1;
      if (prev >= 0) {
        (e.currentTarget.parentElement?.children[prev] as HTMLElement)?.focus();
      }
    }
  }

  function handleModeNext() {
    if (selectedMode !== null) setStep(2);
  }

  function handleGo() {
    if (selectedMode !== null && selectedOrganism !== null) {
      navigate(`/analyze/upload?mode=${selectedMode}&type=${selectedOrganism}`);
    }
  }

  const canAdvanceFromStep1 = selectedMode !== null && MODES.find(m => m.id === selectedMode)?.available === true;
  const canGoFromStep2 = selectedOrganism !== null && ORGANISMS.find(o => o.id === selectedOrganism)?.available === true;

  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <Dialog open onOpenChange={() => navigate("/")}>
        <DialogContent className="sm:max-w-md">
          {/* Step indicator */}
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span className={cn("font-medium", step === 1 && "text-foreground")}>1. Mode</span>
            <span>→</span>
            <span className={cn("font-medium", step === 2 && "text-foreground")}>2. Type</span>
          </div>

          {/* Step 1 — Mode selection */}
          {step === 1 && (
            <>
              <DialogHeader>
                <DialogTitle>Select Analysis Mode</DialogTitle>
                <DialogDescription>
                  Choose how to provide images for analysis.
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-4 py-2">
                {MODES.map((mode, i) => (
                  <SelectionCard
                    key={mode.id}
                    label={mode.label}
                    description={mode.description}
                    icon={mode.icon}
                    available={mode.available}
                    selected={selectedMode === mode.id}
                    onSelect={() => handleModeSelect(mode.id)}
                    onKeyDown={(e) => handleModeKeyDown(e, mode.id)}
                    tabIndex={i === 0 ? 0 : -1}
                  />
                ))}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => navigate("/")}>
                  Cancel
                </Button>
                <Button onClick={handleModeNext} disabled={!canAdvanceFromStep1}>
                  Next
                </Button>
              </DialogFooter>
            </>
          )}

          {/* Step 2 — Organism type selection */}
          {step === 2 && (
            <>
              <DialogHeader>
                <DialogTitle>Select Organism Type</DialogTitle>
                <DialogDescription>
                  Choose the type of organism to detect in your images.
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-4 py-2">
                {ORGANISMS.map((org, i) => (
                  <SelectionCard
                    key={org.id}
                    label={org.label}
                    icon={org.icon}
                    available={org.available}
                    selected={selectedOrganism === org.id}
                    onSelect={() => setSelectedOrganism(org.id)}
                    onKeyDown={(e) => handleOrganismKeyDown(e, org.id)}
                    tabIndex={i === 0 ? 0 : -1}
                  />
                ))}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button onClick={handleGo} disabled={!canGoFromStep2}>
                  Go
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
