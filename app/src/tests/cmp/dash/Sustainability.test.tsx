import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sustainability from '../../../cmp/dash/Sustainability';

vi.mock('../../../cmp/charts/DataTable', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

vi.mock('../../../cmp/charts/BarChartDiv', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

describe('Sustainability', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the sustainability dashboard', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                avgBusFactor: 2.5,
                avgContributors: 4.6
            }),
        } as Response);

        render(<Sustainability />);

        await waitFor(() => {
            expect(screen.getByText('Average bus factor')).toBeInTheDocument();
        });

        expect(screen.getByText('2.5')).toBeInTheDocument();

        expect(screen.getByText('Average # contributors')).toBeInTheDocument();
        expect(screen.getByText('4.6')).toBeInTheDocument();

        expect(
            screen.getByText('Sustainability Indicators per University'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Community Files'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Community Files by # Stars'),
        ).toBeInTheDocument();

        expect(screen.getByText('Bus Factor Distribution')).toBeInTheDocument();

        expect(screen.getByText('Contributor Count Distribution')).toBeInTheDocument();
    });

    it('shows an error message when the sustainability request fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
        } as Response);

        render(<Sustainability />);

        expect(
            await screen.findByText(
                'Failed to load sustainability: Error fetching sustainability: 500',
            ),
        ).toBeInTheDocument();
    });
});
