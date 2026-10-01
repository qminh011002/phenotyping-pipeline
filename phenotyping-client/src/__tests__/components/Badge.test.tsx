import { describe, it, expect } from 'vitest';
import { render } from '@/test/setup';
import { screen } from '@testing-library/react';
import { Badge } from '@/components/ui/badge';

describe('Badge', () => {
    it('renders children', () => {
        render(<Badge>Completed</Badge>);
        expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('applies all variants', () => {
        const variants = [
            'default',
            'secondary',
            'destructive',
            'outline',
            'ghost',
            'link',
            'success',
            'warning',
        ] as const;
        for (const variant of variants) {
            const { unmount } = render(<Badge variant={variant}>Badge</Badge>);
            expect(screen.getByText('Badge')).toHaveAttribute('data-variant', variant);
            unmount();
        }
    });

    it('applies default variant', () => {
        render(<Badge>Default</Badge>);
        expect(screen.getByText('Default')).toHaveAttribute('data-variant', 'default');
    });

    it('renders as a span element', () => {
        const { container } = render(<Badge>Span Badge</Badge>);
        expect(container.querySelector('span')).toBeInTheDocument();
    });

    it('applies additional className', () => {
        render(<Badge className="mt-2">Custom</Badge>);
        expect(screen.getByText('Custom')).toHaveClass('mt-2');
    });

    it('renders success variant with the success token', () => {
        render(<Badge variant="success">Success</Badge>);
        expect(screen.getByText('Success')).toHaveClass('bg-success/10', 'text-success');
    });

    it('renders warning variant with the warning token', () => {
        render(<Badge variant="warning">Warning</Badge>);
        expect(screen.getByText('Warning')).toHaveClass('bg-warning/10', 'text-warning');
    });

    it('renders destructive variant', () => {
        render(<Badge variant="destructive">Failed</Badge>);
        expect(screen.getByText('Failed')).toHaveAttribute('data-variant', 'destructive');
    });
});
