// InlineEditableText — click-to-edit text primitive.
// Click switches to an <input>; Enter commits, Escape reverts, blur commits.
// While the save promise is in-flight, input is disabled and a spinner shows.
// On error, the input stays open with the user's typing preserved.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface InlineEditableTextProps {
  value: string;
  onSave: (next: string) => Promise<void>;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  maxLength?: number;
  /** Rendered icon-less if false (useful when the parent renders the pencil). */
  showEditAffordance?: boolean;
  /** Optional accessibility label. */
  ariaLabel?: string;
}

export function InlineEditableText({
  value,
  onSave,
  placeholder = "Untitled",
  className,
  inputClassName,
  maxLength = 200,
  showEditAffordance = true,
  ariaLabel,
}: InlineEditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  const commit = useCallback(async () => {
    const next = draft.trim();
    if (!next) {
      toast.error("Name cannot be empty");
      inputRef.current?.focus();
      return;
    }
    if (next === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      toast.error(msg);
      // Keep editing open with the user's typing preserved.
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [draft, value, onSave]);

  const cancel = useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  if (editing) {
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={() => {
            // Commit if dirty; otherwise exit cleanly. Skip if already saving.
            if (saving) return;
            void commit();
          }}
          disabled={saving}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn(
            "min-w-0 rounded-md border border-input bg-background px-2 py-0.5",
            "text-inherit font-inherit leading-tight",
            "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "disabled:opacity-60",
            inputClassName,
          )}
          style={{ width: `${Math.max(draft.length + 2, 8)}ch` }}
        />
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className={cn(
        "group inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 -mx-1",
        "cursor-text hover:bg-accent/40 transition-colors",
        "focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      title="Click to rename"
      aria-label={ariaLabel}
    >
      <span className={cn("truncate", !value && "text-muted-foreground italic")}>
        {value || placeholder}
      </span>
      {showEditAffordance && (
        <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </span>
  );
}
