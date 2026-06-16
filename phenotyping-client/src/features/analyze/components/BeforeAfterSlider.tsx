import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface BeforeAfterSliderProps {
    beforeSrc: string;
    afterSrc: string;
    beforeLabel?: string;
    afterLabel?: string;
    /** Tilt of the divider in degrees. Positive = top edge leans right. */
    tiltDeg?: number;
    className?: string;
}

export function BeforeAfterSlider({
    beforeSrc,
    afterSrc,
    beforeLabel = 'Before',
    afterLabel = 'After',
    tiltDeg = 12,
    className,
}: BeforeAfterSliderProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState(0.5);
    const [dragging, setDragging] = useState(false);
    const [size, setSize] = useState({ w: 1, h: 1 });

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => {
            const r = el.getBoundingClientRect();
            setSize({ w: r.width || 1, h: r.height || 1 });
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // tan(angle) * (h/2) as a fraction of width — but we need the container
    // size to compute that. We express the offset in px and rebuild clip-path
    // and divider transform from the same source of truth.
    const updateFromClientX = useCallback((clientX: number) => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const p = (clientX - rect.left) / rect.width;
        setPosition(Math.min(1, Math.max(0, p)));
    }, []);

    useEffect(() => {
        if (!dragging) return;
        const onMove = (e: PointerEvent) => updateFromClientX(e.clientX);
        const onUp = () => setDragging(false);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, [dragging, updateFromClientX]);

    const onPointerDown = (e: React.PointerEvent) => {
        setDragging(true);
        updateFromClientX(e.clientX);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setPosition((p) => Math.max(0, p - step));
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setPosition((p) => Math.min(1, p + step));
        } else if (e.key === 'Home') {
            e.preventDefault();
            setPosition(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            setPosition(1);
        }
    };

    // Tilt offset as a fraction of width. tan(θ) * (h/2) ÷ w, derived from the
    // measured container so the divider stays visually 12° regardless of the
    // parent's height.
    const tan = Math.tan((tiltDeg * Math.PI) / 180);
    const offsetFrac = (tan * (size.h / size.w)) / 2;

    const topX = position * 100 + offsetFrac * 100;
    const bottomX = position * 100 - offsetFrac * 100;

    // clip-path keeps the AFTER image to the right of the diagonal.
    const afterClip = `polygon(${topX}% 0, 100% 0, 100% 100%, ${bottomX}% 100%)`;

    return (
        <div
            ref={containerRef}
            className={cn(
                'relative h-full w-full flex-1 select-none overflow-hidden rounded-lg bg-muted',
                className,
            )}
            onPointerDown={onPointerDown}
        >
            <img
                src={beforeSrc}
                alt={beforeLabel}
                draggable={false}
                className="absolute inset-0 h-full w-full object-cover"
            />
            <img
                src={afterSrc}
                alt={afterLabel}
                draggable={false}
                style={{ clipPath: afterClip, WebkitClipPath: afterClip }}
                className="absolute inset-0 h-full w-full object-cover"
            />

            <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm">
                {beforeLabel}
            </span>
            <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-primary/85 px-2 py-0.5 text-[11px] font-medium text-primary-foreground shadow-sm">
                {afterLabel}
            </span>

            {/* Diagonal divider line */}
            <div
                aria-hidden
                className="pointer-events-none absolute top-1/2 h-[140%] w-0.5 bg-white/90 shadow-[0_0_6px_rgba(0,0,0,0.45)]"
                style={{
                    left: `${position * 100}%`,
                    transform: `translate(-50%, -50%) rotate(${tiltDeg}deg)`,
                }}
            />

            {/* Draggable handle, sits on the divider at vertical center */}
            <button
                type="button"
                role="slider"
                aria-label="Reveal comparison"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(position * 100)}
                onKeyDown={onKeyDown}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    setDragging(true);
                }}
                className={cn(
                    'absolute top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-white/90 bg-white text-foreground shadow-md outline-none ring-0 transition-transform',
                    'hover:scale-105 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
                    dragging && 'scale-110',
                )}
                style={{ left: `${position * 100}%` }}
            >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 6 L3 12 L8 18" />
                    <path d="M16 6 L21 12 L16 18" />
                </svg>
            </button>
        </div>
    );
}
