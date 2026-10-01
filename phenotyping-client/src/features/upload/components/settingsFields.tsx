// Field primitives shared by the inference-settings sheets.

import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface LabeledFieldProps {
    htmlFor?: string;
    label: string;
    tooltip: string;
    children: ReactNode;
    error?: string;
    hint?: ReactNode;
}

export function LabeledField({
    htmlFor,
    label,
    tooltip,
    children,
    error,
    hint,
}: LabeledFieldProps) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
                {htmlFor ? (
                    <Label htmlFor={htmlFor} className="text-sm font-medium">
                        {label}
                    </Label>
                ) : (
                    <span className="text-sm font-medium">{label}</span>
                )}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            aria-label={`About ${label}`}
                            className="rounded-sm text-muted-foreground focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                            <Info className="size-3.5" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent
                        side="left"
                        className="max-w-xs text-xs leading-relaxed whitespace-pre-line"
                    >
                        {tooltip}
                    </TooltipContent>
                </Tooltip>
            </div>
            {children}
            {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
            {error && (
                <p className="text-xs text-destructive" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

interface NumberFieldProps {
    id: string;
    value: number;
    onChange: (value: number) => void;
    step?: number;
    min?: number;
    max?: number;
    suffix?: string;
    disabled?: boolean;
}

export function NumberField({
    id,
    value,
    onChange,
    step = 1,
    min,
    max,
    suffix,
    disabled,
}: NumberFieldProps) {
    return (
        <div className="flex items-center gap-2">
            <Input
                id={id}
                type="number"
                value={value}
                step={step}
                min={min}
                max={max}
                disabled={disabled}
                onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) onChange(v);
                }}
                className="w-28 font-mono"
            />
            {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
        </div>
    );
}

interface SliderFieldProps {
    id: string;
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step: number;
    /** How the current value is printed next to the track. */
    format: (value: number) => string;
    disabled?: boolean;
}

export function SliderField({
    id,
    value,
    onChange,
    min,
    max,
    step,
    format,
    disabled,
}: SliderFieldProps) {
    return (
        <div className="flex items-center gap-3">
            <Slider
                id={id}
                min={min}
                max={max}
                step={step}
                value={[value]}
                onValueChange={([v]) => onChange(v)}
                disabled={disabled}
                className="flex-1"
            />
            <span className="w-12 text-right font-mono text-sm tabular-nums">{format(value)}</span>
        </div>
    );
}

/** A titled group of related settings. */
export function SettingsGroup({
    title,
    description,
    children,
}: {
    title: string;
    description?: string;
    children: ReactNode;
}) {
    return (
        <section className="space-y-4">
            <div>
                <h3 className="eyebrow">{title}</h3>
                {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
            </div>
            {children}
        </section>
    );
}

export function SettingsError({ message }: { message: string }) {
    return (
        <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
        >
            {message}
        </div>
    );
}
