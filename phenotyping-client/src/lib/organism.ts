// One description of each organism for the whole UI: its label, what its
// detections are called, and its fixed chart colour. Colour follows the
// organism everywhere (charts, badges, legends) and never depends on which
// organisms happen to be on screen.

import type { Organism } from '@/types/api';

export interface OrganismMeta {
    id: Organism;
    label: string;
    /** What one detection is called, singular / plural. */
    noun: string;
    nounPlural: string;
    /** CSS colour (a `--chart-N` slot) — categorical identity, fixed order. */
    color: string;
    /** Polygon organisms have calibration + size measurements. */
    polygon: boolean;
}

export const ORGANISM_ORDER: Organism[] = ['egg', 'neonate', 'larvae', 'pupae'];

export const ORGANISMS: Record<Organism, OrganismMeta> = {
    egg: {
        id: 'egg',
        label: 'Egg',
        noun: 'egg',
        nounPlural: 'eggs',
        color: 'var(--chart-1)',
        polygon: false,
    },
    neonate: {
        id: 'neonate',
        label: 'Neonate',
        noun: 'neonate',
        nounPlural: 'neonates',
        color: 'var(--chart-2)',
        polygon: false,
    },
    larvae: {
        id: 'larvae',
        label: 'Larvae',
        noun: 'larva',
        nounPlural: 'larvae',
        color: 'var(--chart-3)',
        polygon: true,
    },
    pupae: {
        id: 'pupae',
        label: 'Pupae',
        noun: 'pupa',
        nounPlural: 'pupae',
        color: 'var(--chart-4)',
        polygon: true,
    },
};

export function organismMeta(organism: string | null | undefined): OrganismMeta {
    return ORGANISMS[(organism as Organism) ?? 'egg'] ?? ORGANISMS.egg;
}

export function isPolygonOrganism(organism: string | null | undefined): boolean {
    return organism === 'larvae' || organism === 'pupae';
}

/** "1 larva" / "48 larvae" / "1,204 eggs". */
export function countLabel(organism: string | null | undefined, n: number): string {
    const meta = organismMeta(organism);
    return `${n.toLocaleString()} ${n === 1 ? meta.noun : meta.nounPlural}`;
}
