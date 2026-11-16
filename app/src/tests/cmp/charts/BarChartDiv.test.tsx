import { cloneElement, type ReactElement } from 'react';

vi.mock('recharts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('recharts')>();
    return {
        ...actual,
        ResponsiveContainer: ({
            children,
        }: {
            children: ReactElement<{ width?: number; height?: number }>;
        }) => cloneElement(children, { width: 800, height: 400 }),
    };
});

import { render, screen, waitFor } from '@testing-library/react';
import BarChartDiv from '../../../cmp/charts/BarChartDiv';

describe('BarChartDiv', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('shows a loading state before data arrives', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise(() => {})),
        );
        render(
            <BarChartDiv
                title="Community Files Presence"
                endpoint="overview/communityFilesPresence"
            />,
        );

        expect(
            screen.getByText('Loading Community Files Presence...'),
        ).toBeInTheDocument();
    });

    it('renders a simple bar chart once data loads', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            communityFilesPresence: [
                                { name: 'readme', value: 96.3963963963964 },
                                { name: 'license', value: 74.77477477477478 },
                            ],
                        }),
                }),
            ) as unknown as typeof fetch,
        );

        render(
            <BarChartDiv
                title="Community Files Presence"
                endpoint="overview/communityFilesPresence"
                xLabel="Feature"
                yLabel="Percent of Repositories"
                valueSuffix="%"
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText('Community Files Presence'),
            ).toBeInTheDocument();
        });

        expect(
            await screen.findByText('96.4%', {
                ignore: 'script, style, #recharts_measurement_span',
            }),
        ).toBeInTheDocument();
        expect(await screen.findByText('Feature')).toBeInTheDocument();
    });

    it('renders a stacked bar chart with a legend once data loads', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            languageDistributionByType: [
                                { name: 'Python', DEV: 0.6, EDU: 0.4 },
                                { name: 'JavaScript', DEV: 0.8, EDU: 0.2 },
                            ],
                        }),
                }),
            ) as unknown as typeof fetch,
        );

        render(
            <BarChartDiv
                title="Language Distribution by Type"
                endpoint="overview/languageDistributionByType"
                stacked
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText('Language Distribution by Type'),
            ).toBeInTheDocument();
        });

        expect(await screen.findByText('DEV')).toBeInTheDocument();
        expect(await screen.findByText('EDU')).toBeInTheDocument();
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
            <BarChartDiv
                title="Community Files Presence"
                endpoint="overview/communityFilesPresence"
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText(/Failed to load Community Files Presence/),
            ).toBeInTheDocument();
        });
        expect(
            screen.getByText(
                /Failed to fetch data from overview\/communityFilesPresence/,
            ),
        ).toBeInTheDocument();
    });

    it('fetches from the correct endpoint URL', () => {
        const fetchMock = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetchMock);

        render(
            <BarChartDiv
                title="Community Files Presence"
                endpoint="overview/communityFilesPresence"
            />,
        );

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/overview/communityFilesPresence'),
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('sorts bars from smallest to largest', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve([
                            { name: 'beta', value: 50 },
                            { name: 'alpha', value: 10 },
                            { name: 'gamma', value: 30 },
                        ]),
                }),
            ) as unknown as typeof fetch,
        );

        const { container } = render(
            <BarChartDiv title="Sorted" endpoint="overview/test" />,
        );

        await screen.findByText('10.0');

        const values = Array.from(container.querySelectorAll('text'))
            .map((el) => el.textContent ?? '')
            .filter((t) => /^\d+\.0$/.test(t));

        expect(values).toEqual(['10.0', '30.0', '50.0']);
    });

    it('renders legend labels in black', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve([
                            { name: 'Python', DEV: 0.6, EDU: 0.4 },
                            { name: 'JavaScript', DEV: 0.8, EDU: 0.2 },
                        ]),
                }),
            ) as unknown as typeof fetch,
        );

        const { container } = render(
            <BarChartDiv title="Stacked" endpoint="overview/test" stacked />,
        );

        await screen.findByText('Stacked');

        const labels = container.querySelectorAll(
            '.recharts-legend-item-text span',
        );

        expect(labels.length).toBeGreaterThan(0);
        labels.forEach((label) => {
            expect(label).toHaveStyle({ color: 'rgb(0, 0, 0)' });
        });
    });
});
