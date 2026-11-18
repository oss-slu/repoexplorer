import { render, screen, waitFor } from '@testing-library/react';
import HeatmapTable from '../../../cmp/charts/HeatmapTable';

describe('HeatmapTable', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('shows a loading state before data arrives', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise(() => {})),
        );
        render(
            <HeatmapTable
                title="Average score per Security Metric"
                endpoint="security/avgScorePerMetric"
            />,
        );

        expect(
            screen.getByText('Loading Average score per Security Metric...'),
        ).toBeInTheDocument();
    });

    it('renders a simple heatmap, axis labels, and ticks once data loads', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            avgScorePerMetric: [
                                { name: 'binaryArtifacts', value: 8.45 },
                                { name: 'branchProtection', value: 0.58 },
                            ],
                        }),
                }),
            ) as unknown as typeof fetch,
        );

        const { container } = render(
            <HeatmapTable
                title="Average score per Security Metric"
                endpoint="security/avgScorePerMetric"
            />,
        );

        expect(
            await screen.findByRole('heading', {
                name: 'Average score per Security Metric',
            }),
        ).toBeInTheDocument();
        expect(screen.getByText('Metric averages')).toBeInTheDocument();
        expect(screen.getByText('Average')).toBeInTheDocument();

        expect(container.querySelectorAll('.heatmap-tick-cell span')).toHaveLength(
            2,
        );
        expect(container.querySelector('.heatmap-average-tick')).toBeInTheDocument();

        expect(container.querySelectorAll('.heatmap-score-cell')).toHaveLength(
            2,
        );
        expect(screen.getByText('8.4')).toBeInTheDocument();
        expect(screen.getByText('0.6')).toBeInTheDocument();
    });

    it('shows an error message when the response is not ok', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: false,
                    status: 500,
                }),
            ) as unknown as typeof fetch,
        );

        render(
            <HeatmapTable
                title="Average score per Security Metric"
                endpoint="security/avgScorePerMetric"
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText(
                    /Failed to load Average score per Security Metric/,
                ),
            ).toBeInTheDocument();
        });
        expect(
            screen.getByText(
                /Failed to fetch data from security\/avgScorePerMetric/,
            ),
        ).toBeInTheDocument();
    });

    it('fetches from the correct endpoint URL', () => {
        const fetchMock = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetchMock);

        render(
            <HeatmapTable
                title="Average score per Security Metric"
                endpoint="security/avgScorePerMetric"
            />,
        );

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/security/avgScorePerMetric'),
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            }),
        );
    });
});
