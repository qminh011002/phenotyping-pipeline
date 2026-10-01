// Thumbnail — a lazily-loaded, authenticated image tile with a skeleton
// while loading and an icon fallback when there is nothing to show.

import { ImageIcon } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { useAuthedImage } from '@/hooks/useAuthedImage';
import { useInView } from '@/hooks/useInView';
import { cn } from '@/lib/utils';

interface ThumbnailProps {
    /** Authenticated image URL (see `getThumbnailUrl`); null → placeholder. */
    src: string | null;
    alt: string;
    className?: string;
    imgClassName?: string;
    /** Load immediately instead of waiting to scroll into view. */
    eager?: boolean;
}

export function Thumbnail({ src, alt, className, imgClassName, eager = false }: ThumbnailProps) {
    const [ref, inView] = useInView<HTMLDivElement>();
    const { url, error } = useAuthedImage(src, eager || inView);

    return (
        <div ref={ref} className={cn('relative overflow-hidden bg-muted', className)}>
            {url ? (
                <img
                    src={url}
                    alt={alt}
                    decoding="async"
                    draggable={false}
                    className={cn('h-full w-full object-cover', imgClassName)}
                />
            ) : src && !error ? (
                <Skeleton className="h-full w-full rounded-none" />
            ) : (
                <div className="flex h-full w-full items-center justify-center">
                    <ImageIcon className="size-5 text-muted-foreground/40" aria-hidden />
                </div>
            )}
        </div>
    );
}
