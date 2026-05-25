import { ArrowLeft, Check, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { ResultNavigation } from './ResultNavigation';

interface ResultViewerHeaderProps {
    batchName: string | null;
    batchStatus?: string;
    filename: string;
    currentIndex: number;
    total: number;
    canEdit?: boolean;
    editMode?: boolean;
    isDirty: boolean;
    /** True when the batch has already been saved to Records — hides Finish. */
    isSaved: boolean;
    /** True while the Finish request is in flight. */
    finishing: boolean;
    onBack: () => void;
    onNavigate: (index: number) => void;
    onFinish: () => void;
}

export function ResultViewerHeader({
    batchName,
    batchStatus,
    filename,
    currentIndex,
    total,
    canEdit = true,
    editMode = true,
    isDirty,
    isSaved,
    finishing,
    onBack,
    onNavigate,
    onFinish,
}: ResultViewerHeaderProps) {
    const isBatch = total > 1;
    const isDraft = !isSaved && batchStatus === 'draft';
    const showDirtyHint = canEdit && editMode && isDirty;

    async function copyFilename() {
        try {
            await navigator.clipboard.writeText(filename);
            toast.success('Filename copied');
        } catch {
            toast.error('Failed to copy filename');
        }
    }

    return (
        <header className="bg-card grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b px-5 py-2.5">
            {/* Left — back + batch name + filename */}
            <div className="flex min-w-0 items-center gap-3">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={onBack}
                    title="Back"
                    className="h-8 w-8 shrink-0"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Button>

                <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                        <span
                            className="truncate font-semibold text-foreground"
                            title={batchName ?? ''}
                        >
                            {batchName ?? 'Untitled batch'}
                        </span>
                        {isDraft && (
                            <span className="inline-flex shrink-0 items-center rounded-sm bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                                Draft
                            </span>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={copyFilename}
                        title="Click to copy filename"
                        className={cn(
                            'group flex max-w-full items-center gap-1.5 -mx-0.5 px-0.5',
                            'rounded-sm text-left font-mono text-xs text-muted-foreground',
                            'hover:text-foreground',
                            'focus:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/60 focus-visible:text-foreground',
                        )}
                    >
                        <span className="truncate">{filename}</span>
                        <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                    </button>
                </div>
            </div>

            {/* Center — prev/next image navigation */}
            <div className="flex items-center justify-center">
                {isBatch && (
                    <ResultNavigation
                        total={total}
                        currentIndex={currentIndex}
                        onNavigate={onNavigate}
                    />
                )}
            </div>

            {/* Right — status hint + Save */}
            <div className="flex items-center justify-end gap-3">
                {showDirtyHint && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                        <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inset-0 animate-ping rounded-full bg-amber-500/70" />
                            <span className="relative h-1.5 w-1.5 rounded-full bg-amber-500" />
                        </span>
                        Auto-saving
                    </span>
                )}
                <Button size="sm" onClick={onFinish} disabled={finishing} className="gap-2">
                    {finishing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Check className="h-4 w-4" />
                    )}
                    {finishing ? 'Saving…' : isSaved ? 'Save' : 'Finish'}
                </Button>
            </div>
        </header>
    );
}
