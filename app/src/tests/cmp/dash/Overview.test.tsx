import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Overview from '../../../cmp/dash/Overview';

vi.mock('../../../cmp/charts/DataTable', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

vi.mock('../../../cmp/charts/PieChartDiv', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

vi.mock('../../../cmp/charts/BarChartDiv', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

describe('Overview', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the overview dashboard', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                totalRepos: 42,
                percentWithLicense: 57.142857,
                totalContributors: 451,
                avgBusFactor: 2.833333,
            }),
        } as Response);

        render(<Overview filters={{}} />);

        await waitFor(() => {
            expect(screen.getByText('Total repositories')).toBeInTheDocument();
        });

        expect(screen.getByText('42')).toBeInTheDocument();

        expect(screen.getByText('Total contributors')).toBeInTheDocument();
        expect(screen.getByText('451')).toBeInTheDocument();

        expect(
            screen.getByText('Repositories with a license'),
        ).toBeInTheDocument();
        expect(screen.getByText('57.1%')).toBeInTheDocument();

        expect(screen.getByText('Average bus factor')).toBeInTheDocument();
        expect(screen.getByText('2.8')).toBeInTheDocument();

        expect(
            screen.getByText('Repositories per University'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Project Type Distribution'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Community Files Presence'),
        ).toBeInTheDocument();

        expect(screen.getByText('Language Distribution')).toBeInTheDocument();

        expect(screen.getByText('License Distribution')).toBeInTheDocument();

        expect(
            screen.getByText('Language Distribution by Type'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('License Distribution by Type'),
        ).toBeInTheDocument();
    });

    it('shows an error message when the overview request fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
        } as Response);

        render(<Overview filters={{}} />);

        expect(
            await screen.findByText(
                'Failed to load overview: Error fetching overview: 500',
            ),
        ).toBeInTheDocument();
    });
    it('refetches overview data when filters change', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                totalRepos: 42,
                percentWithLicense: 57.142857,
                totalContributors: 451,
                avgBusFactor: 2.833333,
            }),
        } as Response);

        const { rerender } = render(<Overview filters={{}} />);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        rerender(<Overview filters={{ language: 'Python' }} />);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        expect(fetchMock).toHaveBeenLastCalledWith(
            expect.stringContaining('language=Python'),
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            }),
        );
    });
});
