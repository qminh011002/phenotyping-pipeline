// Top bar of the result viewer: where you are (batch · file), where you can
// go (prev / next), and what state the work is in (autosave, Finish).

import type { ReactNode } from 'react';
import { ArrowLeft, Check, CloudCheck, Copy, Keyboard, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { OrganismBadge, StatusBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { ResultNavigation } from './ResultNavigation';

interface ResultViewerHeaderProps {
    batchName: string | null;
    batchStatus?: string;
    organism?: string;
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
    /** Opens the keyboard-shortcut reference; omit to hide the button. */
    onShowShortcuts?: () => void;
    /** Extra buttons placed left of Finish (download, add images, …). */
    actions?: ReactNode;
}

export function ResultViewerHeader({
    batchName,
    batchStatus,
    organism,
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
    onShowShortcuts,
    actions,
}: ResultViewerHeaderProps) {
    const isBatch = total > 1;
    const editable = canEdit && editMode;

    async function copyFilename() {
        try {
            await navigator.clipboard.writeText(filename);
            toast.success('Filename copied');
        } catch {
            toast.error('Failed to copy filename');
        }
    }

    return (
        <header className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-border bg-card px-3">
            {/* Left — back + batch name + filename */}
            <div className="flex min-w-0 items-center gap-2">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={onBack}
                    title="Back"
                    aria-label="Back"
                    className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft />
                </Button>

                <div className="flex min-w-0 flex-col">
                    <div className="flex min-w-0 items-center gap-2 text-sm leading-tight">
                        <span
                            className="truncate font-semibold tracking-tight text-foreground"
                            title={batchName ?? ''}
                        >
                            {batchName ?? 'Untitled batch'}
                        </span>
                        {organism && <OrganismBadge organism={organism} />}
                        {batchStatus && batchStatus !== 'completed' && (
                            <StatusBadge status={batchStatus} />
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={copyFilename}
                        title="Click to copy filename"
                        className={cn(
                            'group -mx-0.5 flex max-w-full items-center gap-1 px-0.5',
                            'rounded-sm text-left font-mono text-[11px] leading-snug text-muted-foreground',
                            'hover:text-foreground',
                            'focus:outline-none focus-visible:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/60',
                        )}
                    >
                        <span className="truncate">{filename}</span>
                        <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
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

            {/* Right — autosave state, shortcuts, actions, Finish */}
            <div className="flex items-center justify-end gap-2">
                {editable && (
                    <span
                        className="mr-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
                        aria-live="polite"
                    >
                        {isDirty ? (
                            <>
                                <span className="relative flex size-1.5">
                                    <span className="absolute inset-0 animate-ping rounded-full bg-warning/70" />
                                    <span className="relative size-1.5 rounded-full bg-warning" />
                                </span>
                                Auto-saving
                            </>
                        ) : (
                            <>
                                <CloudCheck className="size-3.5 text-success" aria-hidden />
                                <span className="hidden lg:inline">All changes saved</span>
                            </>
                        )}
                    </span>
                )}
                {onShowShortcuts && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={onShowShortcuts}
                                aria-label="Keyboard shortcuts"
                                className="size-8 text-muted-foreground hover:text-foreground"
                            >
                                <Keyboard />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                            Keyboard shortcuts <span className="ml-1 font-mono opacity-70">?</span>
                        </TooltipContent>
                    </Tooltip>
                )}
                {actions}
                <Button size="sm" onClick={onFinish} disabled={finishing} className="h-8 gap-1.5">
                    {finishing ? <Loader2 className="animate-spin" /> : <Check />}
                    {finishing ? 'Saving…' : isSaved ? 'Save' : 'Finish'}
                </Button>
            </div>
        </header>
    );
}
