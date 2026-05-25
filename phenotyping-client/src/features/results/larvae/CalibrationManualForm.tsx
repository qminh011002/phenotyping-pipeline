// CalibrationManualForm — numeric mm-per-pixel override (FE-034).
// Useful when no green square is visible in the frame.

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CalibrationManualFormProps {
    initialX?: number | null;
    initialY?: number | null;
    saving?: boolean;
    onSave: (mmPerPxX: number, mmPerPxY: number) => void;
    onCancel: () => void;
}

export function CalibrationManualForm({
    initialX,
    initialY,
    saving = false,
    onSave,
    onCancel,
}: CalibrationManualFormProps) {
    const [x, setX] = useState(() => (initialX != null ? String(initialX) : ''));
    const [y, setY] = useState(() => (initialY != null ? String(initialY) : ''));
    const [isotropic, setIsotropic] = useState(true);

    useEffect(() => {
        if (isotropic) setY(x);
    }, [isotropic, x]);

    const xNum = parseFloat(x);
    const yNum = parseFloat(y);
    const valid =
        Number.isFinite(xNum) &&
        Number.isFinite(yNum) &&
        xNum > 0 &&
        xNum < 100 &&
        yNum > 0 &&
        yNum < 100;

    return (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
            <p className="text-xs text-muted-foreground">
                Overriding auto-detected calibration. Values must be {'>'} 0 and {'<'} 100 mm/px.
            </p>
            <div className="flex items-center gap-2">
                <Checkbox
                    id="cal-iso"
                    checked={isotropic}
                    onCheckedChange={(v) => setIsotropic(Boolean(v))}
                />
                <Label htmlFor="cal-iso" className="text-xs font-normal">
                    Same for both axes
                </Label>
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                    <Label htmlFor="cal-x" className="text-xs">
                        mm / px (X)
                    </Label>
                    <Input
                        id="cal-x"
                        type="number"
                        step="0.0001"
                        min="0"
                        value={x}
                        onChange={(e) => setX(e.target.value)}
                    />
                </div>
                <div className="space-y-1">
                    <Label htmlFor="cal-y" className="text-xs">
                        mm / px (Y)
                    </Label>
                    <Input
                        id="cal-y"
                        type="number"
                        step="0.0001"
                        min="0"
                        value={y}
                        onChange={(e) => setY(e.target.value)}
                        disabled={isotropic}
                    />
                </div>
            </div>
            <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
                    Cancel
                </Button>
                <Button
                    size="sm"
                    onClick={() => valid && onSave(xNum, yNum)}
                    disabled={!valid || saving}
                >
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </div>
        </div>
    );
}
