import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Impact from '../../../cmp/dash/Impact';

vi.mock('../../../cmp/charts/DataTable', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

vi.mock('../../../cmp/charts/BarChartDiv', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

vi.mock('../../../cmp/charts/DataBlock', () => ({
    default: ({ header, value }: { header?: string; value?: number }) => (
        <div>
            {header}: {value}
        </div>
    ),
}));

describe('Impact', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the loading state initially', () => {
        // Mock fetch to a pending promise so we can catch the loading state
        vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
            () => new Promise(() => {}),
        );

        render(<Impact />);
        expect(
            screen.getByText(/Loading impact dashboard.../i),
        ).toBeInTheDocument();
    });

    it('renders the impact dashboard on success', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                totalStars: 100,
                totalForks: 50,
                totalDownloads: 200,
                totalContributors: 25,
            }),
        } as Response);

        render(<Impact />);

        // Wait for the fetch to resolve and the table title to appear
        await waitFor(() => {
            expect(
                screen.getByText('Impact Indicators per University'),
            ).toBeInTheDocument();
        });

        // Verify DataBlocks rendered
        expect(screen.getByText('Total stars: 100')).toBeInTheDocument();
        expect(screen.getByText('Total forks: 50')).toBeInTheDocument();
        expect(screen.getByText('Total downloads: 200')).toBeInTheDocument();
        expect(screen.getByText('Total contributors: 25')).toBeInTheDocument();

        // Verify BarChartDivs rendered
        expect(screen.getByText('Stars Distribution')).toBeInTheDocument();
        expect(screen.getByText('Forks Distribution')).toBeInTheDocument();
        expect(
            screen.getByText('Release Downloads Distribution'),
        ).toBeInTheDocument();
        expect(
            screen.getByText('Contributors Distribution'),
        ).toBeInTheDocument();
    });

    it('shows an error message when the impact request fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
        } as Response);

        render(<Impact />);

        expect(
            await screen.findByText(
                'Failed to load impact dashboard: Error fetching impact data: 500',
            ),
        ).toBeInTheDocument();
    });
});
