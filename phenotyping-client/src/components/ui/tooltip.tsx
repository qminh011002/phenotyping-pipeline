import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function TooltipProvider({
    delayDuration = 200,
    // 0 = every tooltip waits its own delay, so sweeping the cursor across a
    // row of buttons doesn't flash one tooltip after another.
    skipDelayDuration = 0,
    ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
    return (
        <TooltipPrimitive.Provider
            data-slot="tooltip-provider"
            delayDuration={delayDuration}
            skipDelayDuration={skipDelayDuration}
            {...props}
        />
    );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
    return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
    className,
    sideOffset = 8,
    children,
    ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
                data-slot="tooltip-content"
                sideOffset={sideOffset}
                className={cn(
                    // Fade only — no zoom/slide, so the tooltip appears in place.
                    'z-50 w-fit animate-in rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md [animation-duration:120ms] fade-in-0 data-[state=closed]:animate-out data-[state=closed]:[animation-duration:80ms] data-[state=closed]:fade-out-0',
                    className,
                )}
                {...props}
            >
                {children}
                <TooltipPrimitive.Arrow
                    width={12}
                    height={7}
                    className="z-50 fill-popover stroke-border stroke-2"
                />
            </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
    );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
