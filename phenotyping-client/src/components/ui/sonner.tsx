import {
    CircleCheckIcon,
    InfoIcon,
    Loader2Icon,
    OctagonXIcon,
    TriangleAlertIcon,
    XIcon,
} from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { toast } from 'sonner';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const toastClassNames: NonNullable<ToasterProps['toastOptions']>['classNames'] = {
    // Shape (radius, keycap bottom edge, padding) lives in `.toaster` in
    // index.css — Sonner's own unlayered CSS outranks utilities here.
    toast: 'group text-card-foreground',
    content: 'min-w-0 flex-1 pr-8',
    icon: 'flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/70 text-muted-foreground',
    title: 'text-sm font-semibold leading-5 tracking-tight',
    description: 'mt-1 text-[13px] leading-5 text-muted-foreground',
    loader: 'text-current',
    closeButton: 'sonner-close-button',
    actionButton: buttonVariants({ size: 'sm' }),
    cancelButton: buttonVariants({ variant: 'secondary', size: 'sm' }),
    loading:
        '[&_[data-icon]]:border-primary/15 [&_[data-icon]]:bg-primary/10 [&_[data-icon]]:text-primary',
    success:
        '[&_[data-icon]]:border-emerald-500/20 [&_[data-icon]]:bg-emerald-500/10 [&_[data-icon]]:text-emerald-600 dark:[&_[data-icon]]:text-emerald-300',
    info: '[&_[data-icon]]:border-sky-500/20 [&_[data-icon]]:bg-sky-500/10 [&_[data-icon]]:text-sky-600 dark:[&_[data-icon]]:text-sky-300',
    warning:
        '[&_[data-icon]]:border-amber-500/20 [&_[data-icon]]:bg-amber-500/10 [&_[data-icon]]:text-amber-600 dark:[&_[data-icon]]:text-amber-300',
    error: '[&_[data-icon]]:border-destructive/20 [&_[data-icon]]:bg-destructive/10 [&_[data-icon]]:text-destructive dark:[&_[data-icon]]:text-red-300',
};

const Toaster = ({ className, icons, toastOptions, ...props }: ToasterProps) => {
    const { theme } = useTheme();

    return (
        <Sonner
            theme={theme}
            className={cn('toaster', className)}
            position="top-center"
            visibleToasts={4}
            closeButton
            expand={false}
            richColors={false}
            offset={16}
            mobileOffset={16}
            icons={{
                success: <CircleCheckIcon className="size-4" />,
                info: <InfoIcon className="size-4" />,
                warning: <TriangleAlertIcon className="size-4" />,
                error: <OctagonXIcon className="size-4" />,
                loading: <Loader2Icon className="size-4 animate-spin" />,
                close: <XIcon className="size-3.5" />,
                ...icons,
            }}
            toastOptions={{
                ...toastOptions,
                duration: toastOptions?.duration ?? 4000,
                closeButton: toastOptions?.closeButton ?? true,
                closeButtonAriaLabel: toastOptions?.closeButtonAriaLabel ?? 'Dismiss notification',
                className: cn('sonner-toast', toastOptions?.className),
                classNames: {
                    ...toastClassNames,
                    ...toastOptions?.classNames,
                },
            }}
            {...props}
        />
    );
};

export { Toaster };
export { toast };
