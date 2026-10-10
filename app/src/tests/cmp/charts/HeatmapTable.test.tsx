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

    it('renders a simple heatmap once data loads', async () => {
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

        render(
            <HeatmapTable
                title="Average score per Security Metric"
                endpoint="security/avgScorePerMetric"
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText('Average score per Security Metric'),
            ).toBeInTheDocument();
        });
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
                screen.getByText(/Failed to load Average score per Security Metric/),
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
        );
    });
});
