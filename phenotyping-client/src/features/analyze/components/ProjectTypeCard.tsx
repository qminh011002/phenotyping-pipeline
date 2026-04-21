import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ProjectTypeDef } from '../constants';

interface ProjectTypeCardProps {
    type: ProjectTypeDef;
    selected: boolean;
    onSelect: () => void;
    isFirst?: boolean;
    isLast?: boolean;
}

export function ProjectTypeCard({
    type,
    selected,
    onSelect,
    isFirst,
    isLast,
}: ProjectTypeCardProps) {
    const { label, description, badges, available } = type;

    return (
        <button
            type="button"
            disabled={!available}
            onClick={available ? onSelect : undefined}
            aria-pressed={selected}
            aria-disabled={!available}
            className={cn(
                'relative flex w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors',
                'focus:outline-none not-first:border-t-0 first:rounded-t-lg last:rounded-b-lg focus-visible:z-10 border focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                available
                    ? selected
                        ? 'bg-primary/5 border-green-600! border-t! cursor-pointer'
                        : 'hover:bg-accent cursor-pointer'
                    : 'bg-muted/20 cursor-not-allowed opacity-60',
            )}
        >
            {/*  */}

            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span className="text-base font-semibold">{label}</span>
                    {!available && (
                        <span className="rounded-full bg-muted-foreground/20 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Soon
                        </span>
                    )}
                </div>
                <span className="text-sm text-muted-foreground">{description}</span>
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
