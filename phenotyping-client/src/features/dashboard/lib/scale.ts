// Axis helpers for the dashboard's hand-built charts.

/**
 * Round tick values covering [0, max]: 0, step, 2·step… where step is 1, 2,
 * 2.5 or 5 × 10ⁿ. Returns at least [0, 1] so an all-zero chart still has an
 * axis.
 */
export function niceTicks(max: number, target = 4): number[] {
    if (!Number.isFinite(max) || max <= 0) return [0, 1];
    const rough = max / target;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / magnitude;
    const step =
        (normalized <= 1
            ? 1
            : normalized <= 2
              ? 2
              : normalized <= 2.5
                ? 2.5
                : normalized <= 5
                  ? 5
                  : 10) * magnitude;
    const ticks: number[] = [];
    for (let v = 0; v < max + step - 1e-9; v += step) {
        // Kill float noise like 0.30000000000000004.
        ticks.push(Number(v.toPrecision(12)));
    }
    return ticks;
}

/** Indices to label when there is room for roughly `max` labels on an axis. */
export function labelIndices(count: number, max = 7): Set<number> {
    if (count <= max) return new Set(Array.from({ length: count }, (_, i) => i));
    const step = Math.ceil(count / max);
    const out = new Set<number>();
    for (let i = 0; i < count; i += step) out.add(i);
    return out;
}
