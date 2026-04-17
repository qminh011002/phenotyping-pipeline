import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { useTheme } from "@/hooks/useTheme"
import { toast } from "sonner"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { cn } from "@/lib/utils"

const toastClassNames: NonNullable<ToasterProps["toastOptions"]>["classNames"] = {
  toast:
    "group flex items-start gap-3 rounded-xl border border-border/80 bg-card p-4 text-card-foreground shadow-lg",
  content: "min-w-0 flex-1 pr-8",
  icon:
    "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/70 text-muted-foreground shadow-xs",
  title: "text-sm font-semibold leading-5 tracking-tight",
  description: "mt-1 text-[13px] leading-5 text-muted-foreground",
  loader: "text-current",
  closeButton: "sonner-close-button",
  actionButton:
    "inline-flex h-8 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
  cancelButton:
    "inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
  default: "border-border/80",
  loading:
    "border-border/80 [&_[data-icon]]:border-primary/15 [&_[data-icon]]:bg-primary/10 [&_[data-icon]]:text-primary",
  success:
    "border-l-[3px] border-l-emerald-500/80 [&_[data-icon]]:border-emerald-500/20 [&_[data-icon]]:bg-emerald-500/10 [&_[data-icon]]:text-emerald-600 dark:[&_[data-icon]]:text-emerald-300",
  info:
    "border-l-[3px] border-l-sky-500/80 [&_[data-icon]]:border-sky-500/20 [&_[data-icon]]:bg-sky-500/10 [&_[data-icon]]:text-sky-600 dark:[&_[data-icon]]:text-sky-300",
  warning:
    "border-l-[3px] border-l-amber-500/80 [&_[data-icon]]:border-amber-500/20 [&_[data-icon]]:bg-amber-500/10 [&_[data-icon]]:text-amber-600 dark:[&_[data-icon]]:text-amber-300",
  error:
    "border-l-[3px] border-l-destructive/80 [&_[data-icon]]:border-destructive/20 [&_[data-icon]]:bg-destructive/10 [&_[data-icon]]:text-destructive dark:[&_[data-icon]]:text-red-300",
}

const Toaster = ({ className, icons, toastOptions, ...props }: ToasterProps) => {
  const { theme } = useTheme()

  return (
    <Sonner
      theme={theme}
      className={cn("toaster", className)}
      position="bottom-right"
      visibleToasts={4}
      closeButton
      expand={false}
      richColors={false}
      offset={16}
      mobileOffset={16}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info:    <InfoIcon    className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error:   <OctagonXIcon  className="size-4" />,
        loading: <Loader2Icon  className="size-4 animate-spin" />,
        close: <XIcon className="size-3.5" />,
        ...icons,
      }}
      toastOptions={{
        ...toastOptions,
        duration: toastOptions?.duration ?? 4000,
        closeButton: toastOptions?.closeButton ?? true,
        closeButtonAriaLabel:
          toastOptions?.closeButtonAriaLabel ?? "Dismiss notification",
        className: cn("sonner-toast", toastOptions?.className),
        classNames: {
          ...toastClassNames,
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
export { toast }
