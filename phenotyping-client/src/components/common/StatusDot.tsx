import { cn } from "@/lib/utils";

interface StatusDotProps {
  status: "success" | "warning" | "error" | "processing" | "idle";
  className?: string;
}

const STATUS_COLORS: Record<StatusDotProps["status"], string> = {
  success:    "bg-green-500",
  warning:    "bg-amber-500",
  error:      "bg-destructive",
  processing: "bg-primary animate-pulse",
  idle:       "bg-muted-foreground",
};

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span
      role="status"
      aria-label={status}
      className={cn("inline-block size-2 rounded-full shrink-0", STATUS_COLORS[status], className)}
    />
  );
}
