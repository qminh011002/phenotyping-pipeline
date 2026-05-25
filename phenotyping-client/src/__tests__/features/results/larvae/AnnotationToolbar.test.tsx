import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/setup';
import { fireEvent, screen } from '@testing-library/react';

import { AnnotationToolbar } from '@/features/results/components/AnnotationToolbar';

describe('AnnotationToolbar', () => {
    it('disables polygon tools for egg', () => {
        render(<AnnotationToolbar organism="egg" />);
        expect(screen.getByLabelText('Polygon')).toBeDisabled();
        expect(screen.getByLabelText('Calibrate')).toBeDisabled();
        expect(screen.getByLabelText('Select')).not.toBeDisabled();
    });

    it('disables bbox tools for larvae but keeps Select enabled', () => {
        render(<AnnotationToolbar organism="larvae" />);
        // Select is universal across organisms.
        expect(screen.getByLabelText('Select')).not.toBeDisabled();
        expect(screen.getByLabelText('Add box')).toBeDisabled();
        expect(screen.getByLabelText('Polygon')).not.toBeDisabled();
        expect(screen.getByLabelText('Calibrate')).not.toBeDisabled();
    });

    it('renders the same number of buttons regardless of organism', () => {
        const { container: eggC } = render(<AnnotationToolbar organism="egg" />);
        const { container: larvaeC } = render(<AnnotationToolbar organism="larvae" />);
        expect(eggC.querySelectorAll('button').length).toBe(
            larvaeC.querySelectorAll('button').length,
        );
    });

    it('fires onSelectTool only when the tool is enabled', () => {
        const onSelect = vi.fn();
        render(<AnnotationToolbar organism="egg" onSelectTool={onSelect} />);
        fireEvent.click(screen.getByLabelText('Select'));
        expect(onSelect).toHaveBeenCalledWith('select');
        // Polygon is disabled for egg.
        fireEvent.click(screen.getByLabelText('Polygon'));
        expect(onSelect).toHaveBeenCalledTimes(1);
    });
});
