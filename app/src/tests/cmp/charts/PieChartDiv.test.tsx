import { render, screen, waitFor } from '@testing-library/react';
import PieChartDiv from '../../../cmp/charts/PieChartDiv';

describe('PieChartDiv', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('shows a loading state before data arrives', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise(() => {})),
        );
        render(<PieChartDiv title="Languages" endpoint="overview/languageDistribution" />);

        expect(screen.getByText('Loading Languages...')).toBeInTheDocument();
    });

    it('renders the chart title and legend once data loads', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve([
                            { name: 'TypeScript', value: 0.6 },
                            { name: 'Python', value: 0.4 },
                        ]),
                }),
            ) as unknown as typeof fetch,
        );

        render(<PieChartDiv title="Languages" endpoint="overview/languageDistribution" />);

        await waitFor(() => {
            expect(screen.getByText('Languages')).toBeInTheDocument();
        });

        expect(screen.getByText('TypeScript')).toBeInTheDocument();
        expect(screen.getByText('Python')).toBeInTheDocument();
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

        render(<PieChartDiv title="Languages" endpoint="overview/languageDistribution" />);

        await waitFor(() => {
            expect(
                screen.getByText(/Failed to load Languages/),
            ).toBeInTheDocument();
        });
        expect(
            screen.getByText(/Error fetching data: 500/),
        ).toBeInTheDocument();
    });

    it('fetches from the correct endpoint URL', () => {
        const fetchMock = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetchMock);

        render(<PieChartDiv title="Languages" endpoint="overview/languageDistribution" />);

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/overview/languageDistribution'),
        );
    });
});
