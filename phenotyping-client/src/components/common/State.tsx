// State — centered, fade-in feedback components: LoadingState, ErrorState, EmptyState.
// All use <FadeIn> from FE-021 motion primitives.

import { AlertCircle, RefreshCw, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "./Spinner";
import { FadeIn } from "@/components/motion/primitives";

// ── LoadingState ─────────────────────────────────────────────────────────────

interface LoadingStateProps {
  label?: string;
  size?: "sm" | "md" | "lg";
}

export function LoadingState({ label, size = "md" }: LoadingStateProps) {
  return (
    <FadeIn className="flex flex-col items-center justify-center gap-3 py-16">
      <Spinner size={size} />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </FadeIn>
  );
}

// ── ErrorState ───────────────────────────────────────────────────────────────

interface ErrorStateProps {
  message?: string;
  title?: string;
  onRetry?: () => void;
  onBack?: () => void;
}

export function ErrorState({
  message,
  title = "Something went wrong",
  onRetry,
  onBack,
}: ErrorStateProps) {
  return (
    <FadeIn className="flex flex-col items-center justify-center gap-4 py-16">
      <Alert variant="destructive" className="max-w-sm">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <AlertTitle>{title}</AlertTitle>
        {message && <AlertDescription>{message}</AlertDescription>}
      </Alert>
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="outline" onClick={onBack}>
            Go Back
          </Button>
        )}
        {onRetry && (
          <Button onClick={onRetry}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        )}
      </div>
    </FadeIn>
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <FadeIn className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 rounded-full bg-muted p-4">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <p className="text-base font-medium">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {actionLabel && onAction && (
        <Button variant="outline" className="mt-4" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </FadeIn>
  );
}