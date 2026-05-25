import { describe, it, expect } from 'vitest';
import { render } from '@/test/setup';
import { screen } from '@testing-library/react';

import { LarvaeCalibrationBanner } from '@/features/results/larvae/LarvaeCalibrationBanner';

describe('LarvaeCalibrationBanner', () => {
    it('renders nothing when calibration is auto-detected (handled by toolbar)', () => {
        const { container } = render(
            <LarvaeCalibrationBanner
                calibration={{ detection_status: 'detected' }}
            />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('shows the manual copy when calibration is manual', () => {
        render(
            <LarvaeCalibrationBanner
                calibration={{ detection_status: 'manual' }}
            />,
        );
        expect(screen.getByText(/Manual calibration/i)).toBeInTheDocument();
    });

    it('shows the failed copy when calibration is failed', () => {
        render(
            <LarvaeCalibrationBanner
                calibration={{ detection_status: 'failed' }}
            />,
        );
        expect(screen.getByText(/Calibration failed/i)).toBeInTheDocument();
    });

    it("shows 'no calibration' when missing entirely", () => {
        render(<LarvaeCalibrationBanner calibration={null} />);
        expect(screen.getByText(/No calibration yet/i)).toBeInTheDocument();
    });
});
