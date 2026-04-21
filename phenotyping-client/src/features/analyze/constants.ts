import {
  Upload,
  Camera,
  Microscope,
  Sprout,
  Bug,
  Worm,
  VectorSquare,
  Hash,
  Lasso,
  RulerDimensionLine,
  Weight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type Mode = "upload" | "camera";
export type Organism = "neonate" | "egg" | "pupae" | "larvae";

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
  { id: "upload", label: "Upload", icon: Upload, available: true },
  { id: "camera", label: "Camera", icon: Camera, available: false },
];

const BOUNDING_BOXES: BadgeDef = { label: "Bounding Boxes", icon: VectorSquare };
const COUNTS: BadgeDef = { label: "Counts", icon: Hash };
const COUNT: BadgeDef = { label: "Count", icon: Hash };
const SEGMENTATION: BadgeDef = { label: "Segmentation", icon: Lasso };
const MEASURING: BadgeDef = { label: "Measuring", icon: RulerDimensionLine };
const WEIGHT: BadgeDef = { label: "Weight", icon: Weight };

export const PROJECT_TYPES: ProjectTypeDef[] = [
  {
    id: "neonate",
    label: "Neonate",
    description: "Detect newly hatched neonates and count them per image.",
    badges: [BOUNDING_BOXES, COUNTS],
    available: true,
    icon: Sprout,
  },
  {
    id: "egg",
    label: "Egg",
    description: "Detect eggs with tiled inference and produce per-image counts.",
    badges: [BOUNDING_BOXES, COUNTS],
    available: true,
    icon: Microscope,
  },
  {
    id: "pupae",
    label: "Pupae",
    description: "Segment individual pupae and measure size and weight.",
    badges: [SEGMENTATION, COUNT, MEASURING, WEIGHT],
    available: false,
    icon: Bug,
  },
  {
    id: "larvae",
    label: "Larvae",
    description: "Segment larvae instances and measure size and weight.",
    badges: [SEGMENTATION, COUNT, MEASURING, WEIGHT],
    available: false,
    icon: Worm,
  },
];
