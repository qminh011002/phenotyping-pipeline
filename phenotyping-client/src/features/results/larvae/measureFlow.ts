// The on-demand measuring pipeline for one stored image:
//
//   (optional) SAM refine → calibration (detect if never tried) → measure
//
// Batches are processed count-only by default, so none of this has run when
// the viewer opens. The result panel drives it for the image on screen or
// for every image of the batch.

import {
    detectCalibration,
    getLarvaeImage,
    measureLarvae,
    refineImagePolygons,
} from '@/services/api';

import type { CalibrationCorners, LarvaeImageDetail } from '@/types/api';

export type MeasureStep = 'refine' | 'calibrate' | 'measure';

export type MeasureOutcome =
    /** Measurements are current. */
    | 'measured'
    /** No usable scale — the user has to set corners or a manual scale. */
    | 'needs_calibration'
    /** Nothing detected on the image, nothing to measure. */
    | 'empty';

export interface MeasureResult {
    outcome: MeasureOutcome;
    /** Fresh server state of the image after whatever steps ran. */
    image: LarvaeImageDetail;
    /** True when a step may have rewritten the stored polygons (SAM refine,
     *  or a first calibration that moved them into the warped frame). */
    polygonsChanged: boolean;
}

export const MEASURE_STEP_LABEL: Record<MeasureStep, string> = {
    refine: 'Refining outlines (SAM)',
    calibrate: 'Finding the calibration',
    measure: 'Measuring sizes',
};

/** A calibration that yields millimetres. */
export function calibrationUsable(calibration: CalibrationCorners | null | undefined): boolean {
    return Boolean(calibration) && calibration!.detection_status !== 'failed';
}

/** What still has to happen before an image's measurements are current. */
export function needsMeasuring(image: {
    detection_count: number;
    measured_count: number;
    stale_count: number;
}): boolean {
    if (image.detection_count === 0) return false;
    return image.stale_count > 0 || image.measured_count < image.detection_count;
}

export async function measureImage(
    batchId: string,
    image: Pick<LarvaeImageDetail, 'image_id' | 'calibration' | 'sam_refined' | 'detection_count'>,
    options: { refine: boolean; onStep?: (step: MeasureStep) => void },
): Promise<MeasureResult> {
    const { refine, onStep } = options;
    const imageId = image.image_id;
    let polygonsChanged = false;

    if (image.detection_count === 0) {
        return { outcome: 'empty', image: await getLarvaeImage(batchId, imageId), polygonsChanged };
    }

    if (refine && !image.sam_refined) {
        onStep?.('refine');
        await refineImagePolygons(batchId, imageId);
        polygonsChanged = true;
    }

    let calibration = image.calibration;
    // Never attempted (older batches, or inference was interrupted): try once.
    // A calibration that already failed is not retried — the image has not
    // changed, so the answer would not either.
    if (!calibration) {
        onStep?.('calibrate');
        calibration = await detectCalibration(imageId);
        polygonsChanged = true;
    }
    if (!calibrationUsable(calibration)) {
        return {
            outcome: 'needs_calibration',
            image: await getLarvaeImage(batchId, imageId),
            polygonsChanged,
        };
    }

    onStep?.('measure');
    await measureLarvae(imageId);
    return { outcome: 'measured', image: await getLarvaeImage(batchId, imageId), polygonsChanged };
}
