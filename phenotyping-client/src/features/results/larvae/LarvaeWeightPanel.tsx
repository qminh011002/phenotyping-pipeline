// LarvaeWeightPanel — per-image total weight (spread across detections by
// area) and the batch-level weight statistics that result from it.

import { useEffect, useState } from 'react';
import { Loader2, Scale } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { organismMeta } from '@/lib/organism';
import { setImageTotalWeight } from '@/services/api';

import type { Organism, WeightStats } from '@/types/api';
import { toastAction } from '@/lib/toasts';

interface LarvaeWeightPanelProps {
    organism: Organism;
    imageId: string;
    totalWeightMg: number | null;
    /** Weight is distributed over measured areas — nothing to spread before measuring. */
    measured: boolean;
    weightStats: WeightStats | null;
    onWeightSaved: () => void;
}

function fmt(n: number | null | undefined, digits = 2): string {
    if (n == null) return '—';
    return n.toFixed(digits);
}

export function LarvaeWeightPanel({
    organism,
    imageId,
    totalWeightMg,
    measured,
    weightStats,
    onWeightSaved,
}: LarvaeWeightPanelProps) {
    const meta = organismMeta(organism);
    const [weightInput, setWeightInput] = useState<string>(
        totalWeightMg != null ? String(totalWeightMg) : '',
    );
    const [saving, setSaving] = useState(false);

    // Sync local input when navigating between images.
    useEffect(() => {
        setWeightInput(totalWeightMg != null ? String(totalWeightMg) : '');
    }, [imageId, totalWeightMg]);

    const dirty = weightInput.trim() !== (totalWeightMg != null ? String(totalWeightMg) : '');

    async function handleSave() {
        const trimmed = weightInput.trim();
        let payloadValue: number | null = null;
        if (trimmed !== '') {
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed) || parsed < 0) {
                toast.error('Total weight must be a non-negative number.');
                return;
            }
            payloadValue = parsed;
        }
        setSaving(true);
        try {
            await toastAction(setImageTotalWeight(imageId, { total_weight_mg: payloadValue }), {
                loading: payloadValue == null ? 'Clearing total weight…' : 'Saving total weight…',
                success:
                    payloadValue == null
                        ? 'Cleared total weight for this image'
                        : { title: 'Total weight saved', description: `${payloadValue} mg` },
                error: 'Failed to save total weight',
            });
            onWeightSaved();
        } catch {
            // Reported by toastAction.
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="space-y-4 p-4">
            <form
                className="space-y-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (dirty && !saving) void handleSave();
                }}
            >
                <label htmlFor="larvae-total-weight" className="eyebrow block">
                    Total weight of this image (mg)
                </label>
                <div className="flex gap-2">
                    <Input
                        id="larvae-total-weight"
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        placeholder="e.g. 1250"
                        value={weightInput}
                        onChange={(e) => setWeightInput(e.target.value)}
                        disabled={saving}
                        className="h-8 text-sm tabular-nums"
                    />
                    <Button type="submit" size="sm" disabled={saving || !dirty}>
                        {saving && <Loader2 className="animate-spin" />}
                        Save
                    </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                    Weigh all {meta.nounPlural} on the image together and enter the total. It is
                    shared out by area, giving each {meta.noun} an estimated weight. Leave blank to
                    clear.
                </p>
                {!measured && (
                    <p className="text-[11px] text-warning">
                        Measure the image first — the weight is distributed over measured areas.
                    </p>
                )}
            </form>

            {weightStats && weightStats.count > 0 ? (
                <section>
                    <h3 className="eyebrow mb-2 flex items-center gap-1.5">
                        <Scale className="size-3.5" aria-hidden />
                        Batch weight statistics
                        <span className="ml-auto font-mono tracking-normal normal-case tabular-nums">
                            n = {weightStats.count}
                        </span>
                    </h3>
                    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-xs">
                        <StatRow
                            label="Total biomass"
                            value={fmt(weightStats.total_biomass_mg)}
                            unit="mg"
                        />
                        <StatRow label="Mean" value={fmt(weightStats.mean)} unit="mg" />
                        <StatRow label="Median" value={fmt(weightStats.median)} unit="mg" />
                        <StatRow label="Std" value={fmt(weightStats.std)} unit="mg" />
                        <StatRow label="CV" value={fmt(weightStats.cv, 3)} unit="" />
                        <StatRow
                            label="Min / Max"
                            value={`${fmt(weightStats.min)} / ${fmt(weightStats.max)}`}
                            unit="mg"
                        />
                        <StatRow
                            label="P5 / P95"
                            value={`${fmt(weightStats.p5)} / ${fmt(weightStats.p95)}`}
                            unit="mg"
                        />
                        <StatRow
                            label="IQR (P25–P75)"
                            value={`${fmt(weightStats.p25)}–${fmt(weightStats.p75)}`}
                            unit="mg"
                        />
                        <StatRow label="Skew" value={fmt(weightStats.skewness, 3)} unit="" />
                        <StatRow label="Kurtosis" value={fmt(weightStats.kurtosis, 3)} unit="" />
                        <StatRow
                            label="Avg W/A"
                            value={fmt(weightStats.avg_weight_area_ratio, 3)}
                            unit=""
                        />
                    </dl>
                </section>
            ) : (
                <p className="rounded-md bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
                    Batch weight statistics appear here once at least one image has a total weight.
                </p>
            )}
        </div>
    );
}

function StatRow({ label, value, unit }: { label: string; value: string; unit: string }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">
                <span className="font-medium">{value}</span>
                {unit && <span className="ml-1 text-[10px] text-muted-foreground">{unit}</span>}
            </dd>
        </>
    );
}
