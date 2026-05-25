// Capability map shared by every organism's result viewer toolbar.
//
// The toolbar's button layout is the same for every organism — tools the
// active model doesn't support are *disabled* (greyed + tooltip), never
// hidden. Users learn one toolbar.

import type { Organism } from '@/types/api';

export interface ToolCapability {
    /** Per-organism support for axis-aligned bbox editing (Select / Move / Add Box / Resize / Delete). */
    bbox: boolean;
    /** Per-organism support for polygon (segmentation) drawing + editing. */
    polygon: boolean;
    /** Per-organism support for the green-rectangle calibration editor. */
    calibration: boolean;
}

export const TOOL_CAPABILITIES: Record<Organism, ToolCapability> = {
    egg: { bbox: true, polygon: false, calibration: false },
    neonate: { bbox: true, polygon: false, calibration: false },
    larvae: { bbox: false, polygon: true, calibration: true },
    pupae: { bbox: false, polygon: true, calibration: true },
};

/** Static disabled-tooltip copy keyed by capability and organism. */
export function disabledReason(
    cap: keyof ToolCapability,
    organism: Organism,
): string {
    const noun: Record<keyof ToolCapability, string> = {
        bbox: 'Bounding-box editing',
        polygon: 'Polygon editing',
        calibration: 'Calibration editing',
    };
    return `${noun[cap]} isn't available for ${organism} analyses.`;
}
