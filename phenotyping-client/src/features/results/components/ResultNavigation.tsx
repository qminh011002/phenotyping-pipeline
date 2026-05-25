// ResultNavigation — prev/next navigation for batch results with keyboard support.

import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ResultNavigationProps {
    total: number;
    currentIndex: number;
    onNavigate: (index: number) => void;
}

export function ResultNavigation({ total, currentIndex, onNavigate }: ResultNavigationProps) {
    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex < total - 1;

    // Keyboard navigation
    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
                return;
            if (e.key === 'ArrowLeft' && hasPrev) onNavigate(currentIndex - 1);
            if (e.key === 'ArrowRight' && hasNext) onNavigate(currentIndex + 1);
        }
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentIndex, hasPrev, hasNext, onNavigate]);

    return (
        <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5">
            <Button
                variant="ghost"
                size="icon"
                disabled={!hasPrev}
                onClick={() => onNavigate(currentIndex - 1)}
                title="Previous (←)"
                aria-label="Previous image"
                className="h-7 w-7"
            >
                <ChevronLeft className="h-4 w-4" />
            </Button>

            <span className="px-2 text-xs font-medium text-foreground tabular-nums">
                <span className="font-mono">{currentIndex + 1}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="font-mono">{total}</span>
            </span>

            <Button
                variant="ghost"
                size="icon"
                disabled={!hasNext}
                onClick={() => onNavigate(currentIndex + 1)}
                title="Next (→)"
                aria-label="Next image"
                className="h-7 w-7"
            >
                <ChevronRight className="h-4 w-4" />
            </Button>
        </div>
    );
}
