import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const skeletonVariants = cva("animate-shimmer rounded-md bg-muted", {
  variants: {
    variant: {
      default: "",
      text:    "h-4 w-full rounded-md",
      circle:  "size-10 rounded-full",
      card:    "h-32 w-full rounded-xl",
      row:     "h-10 w-full rounded-md",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Skeleton({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(skeletonVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Skeleton, skeletonVariants };
