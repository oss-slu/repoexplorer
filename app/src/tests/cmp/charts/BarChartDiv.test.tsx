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
                                { name: 'readme', value: 89.2 },
                                { name: 'license', value: 65.9 },
                            ],
                        }),
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
                screen.getByText('Community Files Presence'),
            ).toBeInTheDocument();
        });
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

        expect(screen.getByText('DEV')).toBeInTheDocument();
        expect(screen.getByText('EDU')).toBeInTheDocument();
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
        );
    });
});
