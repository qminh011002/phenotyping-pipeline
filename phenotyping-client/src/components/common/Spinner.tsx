import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function Spinner({ size = "md", className }: SpinnerProps) {
  const sizeClass =
    size === "sm" ? "size-3" : size === "lg" ? "size-6" : "size-4";
  return (
    <Loader2
      className={cn("animate-spin text-muted-foreground", sizeClass, className)}
      aria-label="Loading"
    />
  );
}
