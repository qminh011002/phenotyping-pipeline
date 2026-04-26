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
                'relative flex w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors',
                'focus:outline-none not-first:border-t-0 first:rounded-t-lg last:rounded-b-lg focus-visible:z-10 border focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                enabled
                    ? selected
                        ? 'bg-primary/5 border-green-600! border-t! cursor-pointer'
                        : 'hover:bg-accent cursor-pointer'
                    : 'bg-muted/20 cursor-not-allowed opacity-60',
            )}
        >
            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span className="text-base font-semibold">{label}</span>
                    {!available && (
                        <span className="rounded-full bg-muted-foreground/20 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
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
                <span className="text-sm text-muted-foreground">
                    {modelMissing ? hint : description}
                </span>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-1.5 pt-0.5">
                {badges.map((b) => {
                    const BIcon = b.icon;
                    return (
                        <Badge key={b.label} variant="secondary" className="gap-1 font-normal">
                            <BIcon className="h-3 w-3" />
                            {b.label}
                        </Badge>
                    );
                })}
            </div>
        </button>
    );
}
