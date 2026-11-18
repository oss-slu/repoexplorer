import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PieChartDiv from '../../../cmp/charts/PieChartDiv';

vi.mock('recharts', async () => {
    const OriginalModule = await vi.importActual('recharts');
    return {
        ...OriginalModule,
        ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
        PieChart: ({ children }: any) => <div>{children}</div>,
        Pie: ({ data }: any) => (
            <div data-testid="pie-data">
                {JSON.stringify(data)}
            </div>
        ),
        Tooltip: () => null,
        Legend: (props: any) => (
            <div>{typeof props.content === 'function' ? props.content() : null}</div>
        ),
    };
});

describe('PieChartDiv', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('shows a loading state before data arrives', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise(() => {})),
        );
        render(
            <PieChartDiv
                title="Languages"
                endpoint="overview/languageDistribution"
            />,
        );

        expect(screen.getByText('Loading Languages...')).toBeInTheDocument();
    });

    it('renders the chart title and legend once data loads', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            languageDistribution: [
                                { name: 'TypeScript', value: 0.6 },
                                { name: 'Unknown', value: 0.4 },
                            ],
                        }),
                }),
            ) as unknown as typeof fetch,
        );

        render(
            <PieChartDiv
                title="Languages"
                endpoint="overview/languageDistribution"
            />,
        );

        await waitFor(() => {
            expect(screen.getByText('Languages')).toBeInTheDocument();
        });

        const legend = await screen.findByRole('list');
        expect(within(legend).getByText('TypeScript')).toBeInTheDocument();
        expect(within(legend).getByText('Other')).toBeInTheDocument();
    });

    it('groups unselected languages into Other', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            languageDistribution: [
                                { name: 'Python', value: 0.4 },
                                { name: 'TypeScript', value: 0.2 },
                                { name: 'Ruby', value: 0.15 },
                                { name: 'Kotlin', value: 0.1 },
                                { name: 'Unknown', value: 0.15 },
                            ],
                        }),
                }),
            ) as unknown as typeof fetch,
        );

        render(
            <PieChartDiv
                title="Language Distribution"
                endpoint="overview/languageDistribution"
            />,
        );

        const legend = await screen.findByRole('list');

        expect(within(legend).getByText('Python')).toBeInTheDocument();
        expect(within(legend).getByText('TypeScript')).toBeInTheDocument();
        expect(within(legend).getByText('Other')).toBeInTheDocument();

        expect(within(legend).queryByText('Ruby')).not.toBeInTheDocument();
        expect(within(legend).queryByText('Kotlin')).not.toBeInTheDocument();
        const pieData = JSON.parse(screen.getByTestId('pie-data').textContent || '[]');

        expect(pieData.find((item: { name: string }) => item.name === 'Other').value)
            .toBeCloseTo(0.4);
    });

    it('keeps the top eight categories for other pie charts', async () => {
        const licenses = Array.from({ length: 10 }, (_, i) => ({
            name: `License ${i + 1}`,
            value: 10 - i,
        }));

        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            licenseDistribution: licenses,
                        }),
                }),
            ) as unknown as typeof fetch,
        );

        render(
            <PieChartDiv
                title="License Distribution"
                endpoint="overview/licenseDistribution"
            />,
        );

        const legend = await screen.findByRole('list');

        expect(within(legend).getByText('License 1')).toBeInTheDocument();
        expect(within(legend).getByText('License 8')).toBeInTheDocument();
        expect(within(legend).getByText('Other')).toBeInTheDocument();

        expect(within(legend).queryByText('License 9')).not.toBeInTheDocument();
        expect(within(legend).queryByText('License 10')).not.toBeInTheDocument();

        const pieData = JSON.parse(
            screen.getByTestId('pie-data').textContent || '[]',
        );

        expect(pieData.find((item: { name: string }) => item.name === 'Other').value)
            .toBe(3);
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
            <PieChartDiv
                title="Languages"
                endpoint="overview/languageDistribution"
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText('Failed to load Languages: Request failed with status 500'),
            ).toBeInTheDocument();
        });
    });

    it('fetches from the correct endpoint URL', () => {
        const fetchMock = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetchMock);

        render(
            <PieChartDiv
                title="Languages"
                endpoint="overview/languageDistribution"
            />,
        );

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('overview/languageDistribution'),
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            }),
        );
    });
});