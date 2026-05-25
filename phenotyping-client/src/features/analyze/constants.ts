import {
    Upload,
    Camera,
    Microscope,
    Sprout,
    Bug,
    Worm,
    Hash,
    Lasso,
    RulerDimensionLine,
    Weight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type Mode = 'upload' | 'camera';
export type Organism = 'neonate' | 'egg' | 'pupae' | 'larvae';

export interface BadgeDef {
    label: string;
    icon: LucideIcon;
}

export interface ModeDef {
    id: Mode;
    label: string;
    icon: LucideIcon;
    available: boolean;
}

export interface ProjectTypeDef {
    id: Organism;
    label: string;
    description: string;
    badges: BadgeDef[];
    available: boolean;
    icon: LucideIcon;
}

export const MODES: ModeDef[] = [
    { id: 'upload', label: 'Upload', icon: Upload, available: true },
    { id: 'camera', label: 'Camera', icon: Camera, available: false },
];

const COUNT: BadgeDef = { label: 'Count', icon: Hash };
const SEGMENTATION: BadgeDef = { label: 'Segmentation', icon: Lasso };
const MEASURING: BadgeDef = { label: 'Measuring', icon: RulerDimensionLine };
const WEIGHT: BadgeDef = { label: 'Weight', icon: Weight };

export const PROJECT_TYPES: ProjectTypeDef[] = [
    {
        id: 'larvae',
        label: 'Larvae',
        description: 'Segment larvae and measure length, width and estimated weight.',
        badges: [COUNT, SEGMENTATION, MEASURING, WEIGHT],
        available: true,
        icon: Worm,
    },
    {
        id: 'pupae',
        label: 'Pupae',
        description: 'Segment pupae and measure length, width and estimated weight.',
        badges: [COUNT, SEGMENTATION, MEASURING, WEIGHT],
        available: true,
        icon: Bug,
    },
    {
        id: 'egg',
        label: 'Egg',
        description: 'Count eggs per image. Counts only — no size or weight output.',
        badges: [COUNT],
        available: true,
        icon: Microscope,
    },
    {
        id: 'neonate',
        label: 'Neonate',
        description: 'Count newly hatched neonates. Counts only — no size or weight output.',
        badges: [COUNT],
        available: true,
        icon: Sprout,
    },
];
