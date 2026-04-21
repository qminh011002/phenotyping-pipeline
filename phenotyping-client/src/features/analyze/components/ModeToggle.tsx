import { cn } from "@/lib/utils";
import { MODES, type Mode } from "../constants";

interface ModeToggleProps {
  value: Mode | null;
  onChange: (mode: Mode) => void;
}

export function ModeToggle({ value, onChange }: ModeToggleProps) {
  return (
    <div className="flex gap-2">
      {MODES.map((m) => {
        const Icon = m.icon;
        const selected = value === m.id;
        return (
          <button
            key={m.id}
            type="button"
            disabled={!m.available}
            onClick={() => m.available && onChange(m.id)}
            aria-pressed={selected}
            className={cn(
              "relative flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm transition-all",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              m.available
                ? selected
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border hover:border-primary/50 hover:bg-accent cursor-pointer"
                : "border-border bg-muted/30 cursor-not-allowed opacity-60",
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="font-medium">{m.label}</span>
            {!m.available && (
              <span className="ml-1 rounded-full bg-muted-foreground/20 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Soon
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
