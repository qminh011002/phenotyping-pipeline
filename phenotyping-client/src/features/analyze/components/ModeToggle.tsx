import { cn } from '@/lib/utils';
import { MODES, type Mode } from '../constants';

interface ModeToggleProps {
    value: Mode | null;
    onChange: (mode: Mode) => void;
}

export function ModeToggle({ value, onChange }: ModeToggleProps) {
    return (
        <div
            role="radiogroup"
            aria-label="Capture mode"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 p-1"
        >
            {MODES.map((m) => {
                const Icon = m.icon;
                const selected = value === m.id;
                return (
                    <button
                        key={m.id}
                        type="button"
                        role="radio"
                        disabled={!m.available}
                        onClick={() => m.available && onChange(m.id)}
                        aria-checked={selected}
                        className={cn(
                            'relative inline-flex items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            m.available
                                ? selected
                                    ? 'bg-background text-foreground shadow-xs'
                                    : 'text-muted-foreground hover:text-foreground cursor-pointer'
                                : 'text-muted-foreground/55 cursor-not-allowed',
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        <span>{m.label}</span>
                        {!m.available && (
                            <span className="ml-0.5 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Soon
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
