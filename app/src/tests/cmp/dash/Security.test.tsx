import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Security from '../../../cmp/dash/Security';

vi.mock('../../../cmp/charts/DataTable', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

vi.mock('../../../cmp/charts/HeatmapTable', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

describe('Security', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the security dashboard', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({}),
        } as Response);

        render(<Security />);

        expect(
            screen.getByText('Security scorecard by repository (OpenSSF Scorecard)'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Average score per Security Metric'),
        ).toBeInTheDocument();
    });

    it('shows an error message when the security request fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
        } as Response);

        render(<Security />);

        expect(
            await screen.findByText(
                'Failed to load security: Error fetching security: 500',
            ),
        ).toBeInTheDocument();
    });
});
