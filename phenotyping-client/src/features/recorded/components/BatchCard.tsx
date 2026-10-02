// BatchCard — gallery card for one analysis batch: cover thumbnail, name,
// organism / status, and a compact stats row. The whole card is a link to the
// batch; the "⋯" menu (Open, Add images, Delete) sits beside it, not inside it.

import { memo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
    Clock,
    FolderOpen,
    Gauge,
    ImagePlus,
    Images,
    Loader2,
    MoreHorizontal,
    Trash2,
} from 'lucide-react';

import { OrganismBadge, StatusBadge, Thumbnail } from '@/components/common';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    formatCount,
    formatDate,
    formatDateTime,
    formatDuration,
    formatElapsed,
    formatPercent,
    pluralize,
    timeAgo,
} from '@/lib/format';
import { countLabel, organismMeta } from '@/lib/organism';
import { useNow } from '@/features/processing/useRunningBatches';
import { cn } from '@/lib/utils';
import { useProcessingStore } from '@/stores/processingStore';
import { getThumbnailUrl } from '@/services/api';
import type { RecordedBatchSummary } from '../hooks/useRecorded';
import { addImagesPath, batchPath } from '../lib/paths';
import { toastAction } from '@/lib/toasts';

export type BatchLayout = 'grid' | 'list';

interface BatchCardProps {
    batch: RecordedBatchSummary;
    onDelete?: (batchId: string) => Promise<void>;
    /** A gallery card, or one row of the list view. */
    layout?: BatchLayout;
}

/** "R2" from a name like "Plate 7_R2" — the re-run marker operators append. */
function versionTag(name: string): string | null {
    const match = name.match(/(?:^|[_\-\s])(R\d+)$/i);
    return match ? match[1].toUpperCase() : null;
}

function Stat({
    icon: Icon,
    title,
    children,
}: {
    icon?: React.ElementType;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap" title={title}>
            {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />}
            {children}
        </span>
    );
}

function BatchCardImpl({ batch, onDelete, layout = 'grid' }: BatchCardProps) {
    const navigate = useNavigate();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const name = batch.name || 'Untitled batch';
    const meta = organismMeta(batch.organism_type);
    const version = versionTag(batch.name);
    const processing = batch.status === 'processing';
    // The run this tab drives has a live page; any other opens as a batch.
    const drivenHere = useProcessingStore(
        (s) => processing && s.isProcessing && s.activeBatchId === batch.id,
    );
    const href = drivenHere ? '/analyze/processing' : batchPath(batch.id);
    // The overlay variant: it shows the detections, and it always exists for a
    // cover image (the raw upload may not have been kept).
    const coverSrc = batch.cover_image_id
        ? getThumbnailUrl(batch.id, batch.cover_image_id, 'overlay', 640)
        : null;

    async function handleDelete() {
        if (!onDelete || deleting) return;
        setDeleting(true);
        try {
            await toastAction(onDelete(batch.id), {
                loading: 'Deleting batch…',
                success: { title: 'Batch deleted', description: batch.name },
                error: 'Failed to delete batch',
            });
            setConfirmOpen(false);
        } catch {
            // Reported by toastAction.
        } finally {
            setDeleting(false);
        }
    }

    const menu = (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Actions for ${name}`}
                    className="pointer-events-auto size-7 data-[state=open]:bg-key-hover"
                >
                    <MoreHorizontal aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => navigate(href)}>
                    <FolderOpen aria-hidden />
                    Open
                </DropdownMenuItem>
                <DropdownMenuItem
                    disabled={processing}
                    onSelect={() => navigate(addImagesPath(batch.id, batch.organism_type))}
                >
                    <ImagePlus aria-hidden />
                    Add images
                </DropdownMenuItem>
                {onDelete && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            // Deleting under a running loop would
                            // strand it mid-upload.
                            disabled={processing}
                            onSelect={() => setConfirmOpen(true)}
                        >
                            <Trash2 aria-hidden />
                            Delete
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );

    const dialog = onDelete && (
        <AlertDialog open={confirmOpen} onOpenChange={(open) => !deleting && setConfirmOpen(open)}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete this batch?</AlertDialogTitle>
                    <AlertDialogDescription>
                        This will permanently remove{' '}
                        <span className="font-medium text-foreground">{name}</span> — the{' '}
                        {meta.label.toLowerCase()} analysis from {formatDate(batch.created_at)} with{' '}
                        {formatCount(batch.total_image_count)}{' '}
                        {pluralize(batch.total_image_count, 'image')}. This action cannot be undone.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                    {/* A plain button, not AlertDialogAction: the dialog stays
                        up (with a spinner) until the request settles. */}
                    <Button
                        variant="destructive"
                        loading={deleting}
                        onClick={() => void handleDelete()}
                    >
                        Delete
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );

    const isList = layout === 'list';
    const stats = (
        <>
            <Stat icon={Images} title="Images in this batch">
                <span className="font-medium text-foreground">
                    {formatCount(batch.total_image_count)}
                </span>
                {pluralize(batch.total_image_count, 'image')}
            </Stat>
            <Stat title={`Total ${meta.nounPlural} counted`}>
                <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.color }}
                />
                {batch.total_count != null ? (
                    <CountText organism={batch.organism_type} n={batch.total_count} />
                ) : (
                    <span>— {meta.nounPlural}</span>
                )}
            </Stat>
            {batch.avg_confidence != null ? (
                <Stat icon={Gauge} title="Average confidence">
                    {formatPercent(batch.avg_confidence, 0)}
                </Stat>
            ) : (
                // List rows keep the column, so the next one stays aligned.
                isList && <span />
            )}
            {batch.total_elapsed_secs != null ? (
                <Stat icon={Clock} title="Processing time">
                    {formatDuration(batch.total_elapsed_secs)}
                </Stat>
            ) : (
                isList && <span />
            )}
        </>
    );

    if (isList) {
        return (
            <div
                className={cn(
                    'group/row flex min-w-0 items-center gap-2 pr-3 transition-[opacity,background-color] duration-150 ease-out hover:bg-muted/40',
                    deleting && 'pointer-events-none opacity-60',
                )}
            >
                <Link
                    to={href}
                    draggable={false}
                    onKeyDown={(e) => {
                        if (e.key === ' ') {
                            e.preventDefault();
                            navigate(href);
                        }
                    }}
                    className="flex min-w-0 flex-1 items-center gap-4 rounded-md py-2.5 pl-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                    <Thumbnail
                        src={coverSrc}
                        alt=""
                        className="aspect-[16/10] w-20 shrink-0 rounded-md border border-border"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <h3 className="truncate text-sm font-semibold" title={name}>
                                {name}
                            </h3>
                            {version && (
                                <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-border bg-card px-1.5 text-[11px] font-semibold">
                                    {version}
                                </span>
                            )}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5">
                            <OrganismBadge organism={batch.organism_type} />
                            <StatusBadge status={batch.status} />
                            {processing ? (
                                <ProcessingInline batch={batch} />
                            ) : (
                                batch.status === 'failed' &&
                                batch.failure_reason && (
                                    <span
                                        className="truncate text-xs text-destructive"
                                        title={batch.failure_reason}
                                    >
                                        {batch.failure_reason}
                                    </span>
                                )
                            )}
                        </div>
                    </div>
                    <div className="hidden shrink-0 grid-cols-[5.5rem_8rem_3.5rem_4.5rem] items-center gap-x-4 text-xs tabular-nums text-muted-foreground md:grid">
                        {stats}
                    </div>
                    <span
                        className="hidden w-24 shrink-0 truncate text-right text-xs text-muted-foreground sm:block"
                        title={formatDateTime(batch.created_at)}
                    >
                        {timeAgo(batch.created_at)}
                    </span>
                </Link>
                {menu}
                {dialog}
            </div>
        );
    }

    return (
        // Link and menu share one grid cell, so the menu floats over the title
        // row without being nested inside the link.
        <div
            className={cn(
                'grid h-full grid-cols-1 transition-opacity duration-150',
                deleting && 'pointer-events-none opacity-60',
            )}
        >
            <Link
                to={href}
                draggable={false}
                onKeyDown={(e) => {
                    // Links answer Enter natively; cards also answer Space.
                    if (e.key === ' ') {
                        e.preventDefault();
                        navigate(href);
                    }
                }}
                className={cn(
                    'group/card panel col-start-1 row-start-1 flex min-w-0 flex-col overflow-hidden outline-none',
                    'transition-[border-color,box-shadow] duration-150 ease-out',
                    'hover:border-foreground/20 hover:shadow-sm',
                    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                )}
            >
                {/* Cover */}
                <div className="relative border-b border-border">
                    <Thumbnail src={coverSrc} alt="" className="aspect-[16/10] w-full" />
                    {/* Hover tint — quiet feedback that reads in both themes */}
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 bg-foreground/0 transition-colors duration-150 ease-out group-hover/card:bg-foreground/5"
                    />
                    {processing && <ProcessingCover batch={batch} />}
                    {version && (
                        <span className="absolute left-2 top-2 inline-flex h-5 items-center rounded-md border border-border bg-card/90 px-1.5 text-[11px] font-semibold text-foreground">
                            {version}
                        </span>
                    )}
                </div>

                {/* Body */}
                <div className="flex flex-1 flex-col gap-2 p-4">
                    {/* pr-8 keeps the name clear of the menu button */}
                    <h3 className="truncate pr-8 text-sm font-semibold leading-6" title={name}>
                        {name}
                    </h3>

                    <div className="flex min-w-0 items-center gap-1.5">
                        <OrganismBadge organism={batch.organism_type} />
                        <StatusBadge status={batch.status} />
                        <span
                            className="ml-auto truncate pl-1 text-xs text-muted-foreground"
                            title={formatDateTime(batch.created_at)}
                        >
                            {timeAgo(batch.created_at)}
                        </span>
                    </div>

                    {batch.status === 'failed' && batch.failure_reason && (
                        <p
                            className="truncate text-xs text-destructive"
                            title={batch.failure_reason}
                        >
                            {batch.failure_reason}
                        </p>
                    )}

                    <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs tabular-nums text-muted-foreground">
                        {stats}
                    </div>
                </div>
            </Link>

            {/* Menu layer — repeats the card's border + cover (as 1px paddings) so
                the button lands on the title row whatever the card width. */}
            <div className="pointer-events-none col-start-1 row-start-1 flex min-w-0 flex-col p-px">
                <div className="pb-px" aria-hidden>
                    <div className="aspect-[16/10] w-full" />
                </div>
                <div className="flex justify-end px-3 pt-3.5">{menu}</div>
            </div>

            {dialog}
        </div>
    );
}

/** Live state over the cover of a batch that is still being analysed: a
 *  scrim, the progress so far and a clock running from the run's start. */
function ProcessingCover({ batch }: { batch: RecordedBatchSummary }) {
    const now = useNow(true);
    const total = batch.total_image_count;
    const done = Math.min(batch.processed_image_count, total);
    const pct = total > 0 ? (done / total) * 100 : 0;
    const startedAt = new Date(batch.processing_started_at ?? batch.created_at).getTime();
    return (
        <div
            className="absolute inset-0 flex flex-col justify-between bg-background/70 p-3 backdrop-blur-[2px]"
            role="status"
            aria-label={`Analysing — ${done} of ${total} images`}
        >
            <span className="inline-flex h-6 w-fit items-center gap-1.5 rounded-md border border-info/25 bg-card/90 px-2 text-xs font-medium text-info">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Analysing
            </span>
            <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                    <span>
                        <span className="text-sm font-semibold">{formatCount(done)}</span>
                        <span className="text-muted-foreground">
                            {' '}
                            of {formatCount(total)} {pluralize(total, 'image')}
                        </span>
                    </span>
                    <span className="text-muted-foreground" title="Time since this run started">
                        {Math.round(pct)}% · {formatElapsed((now - startedAt) / 1000)}
                    </span>
                </div>
                <div
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                >
                    <div
                        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                        style={{ width: `${pct}%` }}
                    />
                </div>
            </div>
        </div>
    );
}

/** Progress of a batch still being analysed, sized for a list row. */
function ProcessingInline({ batch }: { batch: RecordedBatchSummary }) {
    const total = batch.total_image_count;
    const done = Math.min(batch.processed_image_count, total);
    const pct = total > 0 ? (done / total) * 100 : 0;
    return (
        <span
            className="inline-flex min-w-0 items-center gap-1.5 text-xs tabular-nums text-info"
            role="status"
            aria-label={`Analysing — ${done} of ${total} images`}
        >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            {formatCount(done)}/{formatCount(total)}
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                <span
                    className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                    style={{ width: `${pct}%` }}
                />
            </span>
        </span>
    );
}

/** "1,204 eggs" with the number in ink and the noun in muted text. */
function CountText({ organism, n }: { organism: string; n: number }) {
    const label = countLabel(organism, n);
    const split = label.lastIndexOf(' ');
    return (
        <>
            <span className="font-medium text-foreground">{label.slice(0, split)}</span>
            {label.slice(split + 1)}
        </>
    );
}

export const BatchCard = memo(BatchCardImpl);
