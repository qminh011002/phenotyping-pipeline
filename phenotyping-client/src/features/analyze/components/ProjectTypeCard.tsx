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
    /** Filesystem-aware installation state from /models/assignments. A model can
     *  be installed on disk but not loaded into the running backend yet. */
    modelInstalled?: boolean;
}

export function ProjectTypeCard({
    type,
    selected,
    onSelect,
    modelStatus = 'loaded',
    modelInstalled = false,
}: ProjectTypeCardProps) {
    const { label, description, badges, available, id } = type;

    // The "Soon" gate (organism not in MVP) wins over model-status — both
    // disable the card, but we keep the "Soon" copy for unsupported organisms.
    const modelNotReady = available && modelStatus !== 'loaded';
    const modelInstalledButNotLoaded = modelStatus === 'missing' && modelInstalled;
    const enabled = available && !modelNotReady;

    const hint =
        modelStatus === 'error'
            ? 'Failed to load — check backend logs.'
            : modelInstalledButNotLoaded
              ? 'Model file found. Restart the backend so it can be loaded for inference.'
              : `Drop a .pt file into backend/data/models/${id}/default/ and restart, or upload one in Models.`;

    const Icon = type.icon;

    return (
        <button
            type="button"
            disabled={!enabled}
            onClick={enabled ? onSelect : undefined}
            aria-pressed={selected}
            aria-disabled={!enabled}
            className={cn(
                'group relative flex min-h-[96px] w-full items-start gap-4 px-5 py-4 text-left transition-colors',
                'border border-transparent focus:outline-none not-first:border-t-0 first:rounded-t-lg last:rounded-b-lg focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                enabled
                    ? selected
                        ? 'bg-primary/5 text-foreground'
                        : 'text-foreground hover:bg-muted/40 cursor-pointer'
                    : 'bg-muted/10 text-muted-foreground/50 cursor-not-allowed',
            )}
        >
            {selected && (
                <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
            )}

            <span
                className={cn(
                    'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border',
                    selected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : enabled
                          ? 'border-border bg-muted/40 text-muted-foreground'
                          : 'border-border/60 bg-muted/20 text-muted-foreground/50',
                )}
            >
                <Icon className="size-4" />
            </span>

            <div className="min-w-0 flex flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span
                        className={cn(
                            'text-[15px] font-semibold tracking-tight',
                            selected && 'text-primary',
                            !enabled && 'text-muted-foreground/60',
                        )}
                    >
                        {label}
                    </span>
                    {!available && (
                        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Soon
                        </span>
                    )}
                    {available && modelNotReady && (
                        <span
                            className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                                modelStatus === 'error'
                                    ? 'bg-destructive/10 text-destructive'
                                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                            )}
                        >
                            <AlertTriangle className="h-3 w-3" />
                            {modelStatus === 'error'
                                ? 'Model error'
                                : modelInstalledButNotLoaded
                                  ? 'Restart required'
                                  : 'Model not installed'}
                        </span>
                    )}
                </div>
                <span
                    className={cn(
                        'max-w-xl text-[13px] leading-5 text-muted-foreground',
                        !enabled && 'text-muted-foreground/55',
                    )}
                >
                    {modelNotReady ? hint : description}
                </span>
            </div>

            <div className="flex max-w-[280px] shrink-0 flex-wrap items-center justify-end gap-1.5 pt-0.5">
                {badges.map((b) => {
                    const BIcon = b.icon;
                    return (
                        <Badge
                            key={b.label}
                            variant="outline"
                            className={cn(
                                'h-6 rounded-md px-2 text-[11px] font-medium gap-1',
                                selected
                                    ? 'border-primary/30 bg-primary/10 text-primary'
                                    : enabled
                                      ? 'border-border bg-background text-muted-foreground'
                                      : 'border-border/60 bg-background/40 text-muted-foreground/45',
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
