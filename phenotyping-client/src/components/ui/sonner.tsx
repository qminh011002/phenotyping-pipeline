import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-right"
      visibleToasts={4}
      closeButton
      expand={false}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info:    <InfoIcon    className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error:   <OctagonXIcon  className="size-4" />,
        loading: <Loader2Icon  className="size-4 animate-spin" />,
      }}
      toastOptions={{
        duration: 4000,
        className: "rounded-md border bg-popover text-popover-foreground shadow-lg",
        classNames: {
          toast: "group flex items-start gap-3 p-4",
          title: "text-sm font-semibold leading-none",
          description: "text-sm text-muted-foreground mt-1",
          actionButton:
            "rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground",
          cancelButton:
            "rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground",
          success: "border-green-500/30 [&>[data-icon]]:text-green-500",
          error:   "border-destructive/30 [&>[data-icon]]:text-destructive",
          warning: "border-amber-500/30 [&>[data-icon]]:text-amber-500",
          info:    "border-blue-500/30 [&>[data-icon]]:text-blue-500",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
export { toast }
