import { describe, it, expect } from 'vitest';

import { buildLarvaeCsvFilename } from '@/services/api';

describe('buildLarvaeCsvFilename', () => {
    it('uses the batch name and ISO date', () => {
        const date = new Date('2026-05-06T12:00:00Z');
        expect(buildLarvaeCsvFilename('Plate-A', date)).toBe('larvae-Plate-A-2026-05-06.csv');
    });

    it('strips characters that would break a filename', () => {
        const date = new Date('2026-05-06T12:00:00Z');
        expect(buildLarvaeCsvFilename('  Hi/there!  ', date)).toBe(
            'larvae-Hi-there-2026-05-06.csv',
        );
    });

    it("falls back to 'batch' when the name strips to empty", () => {
        const date = new Date('2026-05-06T12:00:00Z');
        expect(buildLarvaeCsvFilename('!!!', date)).toBe('larvae-batch-2026-05-06.csv');
    });
});
