import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/setup';
import { fireEvent, screen } from '@testing-library/react';

import { LarvaeMeasurementTable } from '@/features/results/larvae/LarvaeMeasurementTable';
import type { LarvaeMeasurement, StoredLarvaeAnnotation } from '@/types/api';

function makeDetection(id: string, polygon = [[0, 0], [1, 0], [1, 1]]): StoredLarvaeAnnotation {
    return {
        detection_id: id,
        label: 'larvae',
        polygon: polygon as [number, number][],
        bbox: [0, 0, 1, 1],
        confidence: 0.9,
        area_px: 1,
        origin: 'model',
    };
}

function makeMeasurement(
    id: string,
    overrides: Partial<LarvaeMeasurement> = {},
): LarvaeMeasurement {
    return {
        detection_id: id,
        length_mm: 1,
        min_width_mm: 0.1,
        max_width_mm: 0.2,
        average_width_mm: 0.15,
        area_mm2: 1,
        volume_mm3: 0.1,
        weight_mg: null,
        is_stale: false,
        measured_at: '2026-05-06T00:00:00Z',
        centerline: null,
        widths: null,
        ...overrides,
    };
}

describe('LarvaeMeasurementTable', () => {
    it('renders one row per detection with measurement values', () => {
        const detections = [makeDetection('a'), makeDetection('b')];
        const measurements = [
            makeMeasurement('a', { length_mm: 1.23 }),
            makeMeasurement('b', { length_mm: 4.56 }),
        ];
        render(
            <LarvaeMeasurementTable
                detections={detections}
                measurements={measurements}
                selectedDetectionId={null}
                onSelect={() => {}}
            />,
        );
        expect(screen.getByText('1.23')).toBeInTheDocument();
        expect(screen.getByText('4.56')).toBeInTheDocument();
    });

    it('clicking a row notifies the parent with the detection id', () => {
        const detections = [makeDetection('a'), makeDetection('b')];
        const onSelect = vi.fn();
        render(
            <LarvaeMeasurementTable
                detections={detections}
                measurements={[makeMeasurement('a'), makeMeasurement('b')]}
                selectedDetectionId={null}
                onSelect={onSelect}
            />,
        );
        const row = screen.getByText('#1').closest('[role="row"]');
        fireEvent.click(row!);
        expect(onSelect).toHaveBeenCalledWith('a');
    });

    it('marks the externally-selected row aria-selected', () => {
        const detections = [makeDetection('a'), makeDetection('b')];
        render(
            <LarvaeMeasurementTable
                detections={detections}
                measurements={[makeMeasurement('a'), makeMeasurement('b')]}
                selectedDetectionId="b"
                onSelect={() => {}}
            />,
        );
        const row = screen.getByText('#2').closest('[role="row"]');
        expect(row).toHaveAttribute('aria-selected', 'true');
    });

    it('sorts by length ascending then descending when the header is clicked', () => {
        const detections = [makeDetection('a'), makeDetection('b'), makeDetection('c')];
        const measurements = [
            makeMeasurement('a', { length_mm: 3 }),
            makeMeasurement('b', { length_mm: 1 }),
            makeMeasurement('c', { length_mm: 2 }),
        ];
        render(
            <LarvaeMeasurementTable
                detections={detections}
                measurements={measurements}
                selectedDetectionId={null}
                onSelect={() => {}}
            />,
        );

        const sortBtn = screen.getByText(/Length/);
        fireEvent.click(sortBtn); // asc
        const rowsAsc = screen.getAllByRole('row').slice(1);
        const lengthsAsc = rowsAsc.map((r) => r.children[1].textContent);
        expect(lengthsAsc).toEqual(['1.00', '2.00', '3.00']);

        fireEvent.click(sortBtn); // desc
        const rowsDesc = screen.getAllByRole('row').slice(1);
        const lengthsDesc = rowsDesc.map((r) => r.children[1].textContent);
        expect(lengthsDesc).toEqual(['3.00', '2.00', '1.00']);
    });

});
