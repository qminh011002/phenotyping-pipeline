import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ProjectTypeDef } from '../constants';
import type { ModelStatus } from '@/types/api';

interface ProjectTypeCardProps {
    type: ProjectTypeDef;
    selected: boolean;
    onSelect: () => void;
    /** Per-organism load state from /health. Defaults to "loaded" so legacy
     *  callers that haven't fetched health yet keep the old behaviour. */
    modelStatus?: ModelStatus;
}

export function ProjectTypeCard({
    type,
    selected,
    onSelect,
    modelStatus = 'loaded',
}: ProjectTypeCardProps) {
    const { label, description, badges, available, id } = type;

    // The "Soon" gate (organism not in MVP) wins over model-status — both
    // disable the card, but we keep the "Soon" copy for unsupported organisms.
    const modelMissing = available && modelStatus !== 'loaded';
    const enabled = available && !modelMissing;

    const hint =
        modelStatus === 'error'
            ? 'Failed to load — check backend logs.'
            : `Drop a .pt file into backend/data/models/${id}/default/ and restart, or upload one in Settings → Models.`;

    return (
        <button
            type="button"
            disabled={!enabled}
            onClick={enabled ? onSelect : undefined}
            aria-pressed={selected}
            aria-disabled={!enabled}
            className={cn(
                'group relative flex min-h-[96px] w-full items-start justify-between gap-5 px-6 py-5 text-left transition-colors',
                'border border-transparent focus:outline-none not-first:border-t-0 first:rounded-t-lg last:rounded-b-lg focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                enabled
                    ? selected
                        ? 'border-l-green-600! bg-green-50/70 text-green-700 dark:bg-green-950/20 dark:text-green-300'
                        : 'text-foreground hover:bg-muted/45 cursor-pointer'
                    : 'bg-muted/10 text-muted-foreground/45 cursor-not-allowed',
            )}
        >
            {selected && (
                <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1 bg-green-600"
                />
            )}

            <div className="min-w-0 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                    <span
                        className={cn(
                            'text-base font-semibold',
                            selected && 'text-green-700 dark:text-green-300',
                            !enabled && 'text-muted-foreground/55',
                        )}
                    >
                        {label}
                    </span>
                    {!available && (
                        <span className="rounded-full border border-border/70 bg-background/60 px-2.5 py-0.5 text-[10px] font-semibold text-muted-foreground/65">
                            Soon
                        </span>
                    )}
                    {available && modelMissing && (
                        <span
                            className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                                modelStatus === 'error'
                                    ? 'bg-destructive/10 text-destructive'
                                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                            )}
                        >
                            <AlertTriangle className="h-3 w-3" />
                            {modelStatus === 'error' ? 'Model error' : 'Model not installed'}
                        </span>
                    )}
                </div>
                <span
                    className={cn(
                        'max-w-xl text-sm leading-6 text-muted-foreground',
                        selected && 'text-muted-foreground',
                        !enabled && 'text-muted-foreground/55',
                    )}
                >
                    {modelMissing ? hint : description}
                </span>
            </div>

            <div className="flex max-w-[250px] shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
                {badges.map((b) => {
                    const BIcon = b.icon;
                    return (
                        <Badge
                            key={b.label}
                            variant="outline"
                            className={cn(
                                'h-8 rounded-lg bg-background/80 px-3 text-xs font-semibold shadow-sm',
                                selected
                                    ? 'border-green-200 text-green-700 dark:border-green-800 dark:text-green-300'
                                    : enabled
                                      ? 'text-muted-foreground'
                                      : 'border-border/50 bg-background/35 text-muted-foreground/45 shadow-none',
                            )}
                        >
                            <BIcon className="h-3 w-3" />
                            {b.label}
                        </Badge>
                    );
                })}
            </div>
        </button>
    );
}
