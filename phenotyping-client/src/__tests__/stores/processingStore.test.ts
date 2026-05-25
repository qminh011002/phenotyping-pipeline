import { describe, it, expect, beforeEach } from 'vitest';
import { useProcessingStore } from '@/stores/processingStore';

function getState() {
    return useProcessingStore.getState();
}

describe('processingStore — larvae extensions', () => {
    beforeEach(() => {
        getState().reset();
    });

    it('defaults organism to "egg"', () => {
        expect(getState().organism).toBe('egg');
    });

    it('setOrganism updates the organism field', () => {
        getState().setOrganism('larvae');
        expect(getState().organism).toBe('larvae');
    });

    it('reset restores organism to "egg"', () => {
        getState().setOrganism('larvae');
        getState().reset();
        expect(getState().organism).toBe('egg');
    });

    it('accepts the needs_calibration status on an image', () => {
        getState().startProcessing(2);
        getState().setImages([
            { id: 'a', filename: 'a.jpg', status: 'pending' },
            { id: 'b', filename: 'b.jpg', status: 'pending' },
        ]);
        getState().updateImage('a', { status: 'needs_calibration' });
        getState().updateImage('b', { status: 'done', count: 5 });

        const images = getState().images;
        expect(images.find((i) => i.id === 'a')?.status).toBe('needs_calibration');
        expect(images.find((i) => i.id === 'b')?.status).toBe('done');
    });

    it('persists backendImageId on an image', () => {
        getState().startProcessing(1);
        getState().setImages([{ id: 'a', filename: 'a.jpg', status: 'pending' }]);
        getState().updateImage('a', { backendImageId: 'uuid-123' });
        expect(getState().images[0].backendImageId).toBe('uuid-123');
    });
});
