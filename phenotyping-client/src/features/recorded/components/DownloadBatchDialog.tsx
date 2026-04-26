// DownloadBatchDialog — image selector + ZIP download for a recorded batch.
//
// - Lists completed images only (failed/processing can't be exported).
// - Master checkbox at the top does tri-state select-all / deselect-all.
// - Download streams from POST /analyses/:id/download; we pipe the Blob into
//   an invisible <a download> to trigger the browser save dialog.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { downloadBatchArchive } from '@/services/api';
import type { AnalysisBatchDetail, AnalysisImageSummary } from '@/types/api';

interface DownloadBatchDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    batch: AnalysisBatchDetail;
}

function completedImages(batch: AnalysisBatchDetail): AnalysisImageSummary[] {
    return batch.images.filter((img) => img.status === 'completed');
}

export function DownloadBatchDialog({ open, onOpenChange, batch }: DownloadBatchDialogProps) {
    const images = useMemo(() => completedImages(batch), [batch]);

    // Selection state — starts with every image ticked.
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(images.map((img) => img.id)),
    );
    const [downloading, setDownloading] = useState(false);

    // Re-prime selection only on the false→true open transition so that a
    // batch update (new completion) mid-dialog doesn't wipe the user's choices.
    const prevOpenRef = useRef(open);
    useEffect(() => {
        const wasOpen = prevOpenRef.current;
        prevOpenRef.current = open;
        if (open && !wasOpen) {
            setSelected(new Set(images.map((img) => img.id)));
        }
    }, [open, images]);

    const allSelected = selected.size === images.length && images.length > 0;
    const someSelected = selected.size > 0 && !allSelected;

    function toggleOne(id: string, checked: boolean) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    }

    function toggleAll(checked: boolean) {
        if (checked) {
            setSelected(new Set(images.map((img) => img.id)));
        } else {
            setSelected(new Set());
        }
    }

    async function handleDownload() {
        if (selected.size === 0 || downloading) return;
        setDownloading(true);
        try {
            // When the user has every image ticked, omit image_ids so the backend
            // knows to include the whole batch (and handles future images too).
            const imageIds = allSelected ? null : Array.from(selected);
            const { blob, filename } = await downloadBatchArchive(batch.id, imageIds);

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            // Defer the revoke so Chromium has time to start the download.
            setTimeout(() => URL.revokeObjectURL(url), 10_000);

            toast.success('Download started');
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to download batch');
        } finally {
            setDownloading(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(o) => !downloading && onOpenChange(o)}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Download batch</DialogTitle>
                    <DialogDescription className="truncate" title={batch.name}>
                        {batch.name} · {images.length} completed image
                        {images.length === 1 ? '' : 's'}
                    </DialogDescription>
                </DialogHeader>

                {images.length === 0 ? (
                    <div className="rounded-md border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
                        No completed images to download.
                    </div>
                ) : (
                    <>
                        <SelectAllRow
                            allSelected={allSelected}
                            someSelected={someSelected}
                            count={selected.size}
                            total={images.length}
                            onToggle={toggleAll}
                            disabled={downloading}
                        />
                        <ImageList
                            images={images}
                            selected={selected}
                            onToggleOne={toggleOne}
                            disabled={downloading}
                        />
                    </>
                )}

                <DialogFooter className="mt-2 gap-2 sm:gap-2">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={downloading}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleDownload}
                        disabled={downloading || selected.size === 0}
                        className="gap-2"
                    >
                        {downloading ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Preparing ZIP…
                            </>
                        ) : (
                            <>
                                <Download className="h-4 w-4" />
                                Download .zip ({selected.size})
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface SelectAllRowProps {
    allSelected: boolean;
    someSelected: boolean;
    count: number;
    total: number;
    onToggle: (checked: boolean) => void;
    disabled: boolean;
}

function SelectAllRow({
    allSelected,
    someSelected,
    count,
    total,
    onToggle,
    disabled,
}: SelectAllRowProps) {
    return (
        <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <Checkbox
                    checked={someSelected ? 'indeterminate' : allSelected}
                    onCheckedChange={(v) => onToggle(v === true)}
                    disabled={disabled}
                    aria-label="Select all images"
                />
                <span className="text-sm font-medium">
                    {allSelected ? 'All selected' : someSelected ? 'Some selected' : 'Select all'}
                </span>
            </label>
            <span className="text-xs tabular-nums text-muted-foreground">
                {count} / {total}
            </span>
        </div>
    );
}

interface ImageListProps {
    images: AnalysisImageSummary[];
    selected: Set<string>;
    onToggleOne: (id: string, checked: boolean) => void;
    disabled: boolean;
}

function ImageList({ images, selected, onToggleOne, disabled }: ImageListProps) {
    return (
        <div className="max-h-[50vh] overflow-y-auto rounded-md border">
            <ul className="divide-y">
                {images.map((img) => {
                    const checked = selected.has(img.id);
                    return (
                        <li key={img.id}>
                            <label
                                className={cn(
                                    'flex items-center gap-3 px-3 py-2 cursor-pointer select-none',
                                    'hover:bg-accent/40 transition-colors',
                                )}
                            >
                                <Checkbox
                                    checked={checked}
                                    onCheckedChange={(v) => onToggleOne(img.id, v === true)}
                                    disabled={disabled}
                                    aria-label={`Select ${img.original_filename}`}
                                />
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="truncate font-mono text-xs text-foreground"
                                        title={img.original_filename}
                                    >
                                        {img.original_filename}
                                    </p>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                                        {img.count ?? 0} detections
                                        {img.avg_confidence !== null &&
                                            ` · ${(img.avg_confidence * 100).toFixed(1)}% conf`}
                                    </p>
                                </div>
                            </label>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
