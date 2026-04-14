import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const progressFillVariants = cva("h-full flex-1 transition-[width] duration-300 ease-out", {
  variants: {
    variant: {
      default:    "bg-primary",
      success:    "bg-green-500",
      destructive: "bg-destructive",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Progress({
  className,
  value,
  variant = "default",
  indeterminate = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> &
  VariantProps<typeof progressFillVariants> & {
    indeterminate?: boolean;
  }) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(progressFillVariants({ variant }))}
        style={
          indeterminate
            ? { width: "60%", animation: "progress-indeterminate 1.5s ease-in-out infinite" }
            : { transform: `translateX(-${100 - (value || 0)}%)` }
        }
      />
    </ProgressPrimitive.Root>
  );
}

function ProgressLabel({
  value,
  max,
  label,
  className,
}: {
  value?: number;
  max?: number;
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn("font-mono tabular-nums text-xs text-muted-foreground", className)}>
      {label ?? (value !== undefined && max !== undefined ? `${value} / ${max}` : null)}
    </span>
  );
}

export { Progress, ProgressLabel };
