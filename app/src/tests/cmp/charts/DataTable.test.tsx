import { render, screen, within, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataTable from '../../../cmp/charts/DataTable';

describe('DataTable', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('renders the title', () => {
        render(<DataTable title="University Repositories" />);
        expect(screen.getByText('University Repositories')).toBeInTheDocument();
    });

    it('fetches and displays tabular data', async () => {
        const mockData = [
            { name: 'Saint Louis University', value: 275 },
            { name: 'University of California, Santa Cruz', value: 150 },
        ];

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ reposPerUniversity: mockData }),
            } as Response),
        );

        render(
            <DataTable
                title="Universities"
                endpoint="overview/reposPerUniversity"
            />,
        );

        expect(
            await screen.findByRole('columnheader', { name: 'University' }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole('columnheader', { name: 'Count' }),
        ).toBeInTheDocument();

        const sluRow = await screen.findByRole('row', {
            name: 'Saint Louis University 275',
        });
        const ucscRow = await screen.findByRole('row', {
            name: 'University of California, Santa Cruz 150',
        });
        expect(
            within(sluRow).getByRole('cell', { name: '275' }),
        ).toBeInTheDocument();
        expect(
            within(ucscRow).getByRole('cell', { name: '150' }),
        ).toBeInTheDocument();
    });

    it('renders an error massage on fetch failure', async () => {
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: false,
                status: 500,
            } as Response),
        );

        render(<DataTable title="Universities" endpoint="universities" />);
        expect(
            await screen.findByText(/Failed to load Universities:/),
        ).toBeInTheDocument();
    });

    it('loads next 500 repositories when scrolling near bottom', async () => {
        const firstPage = Array.from({ length: 500 }, (_, index) => ({
            fullName: `Repository ${index + 1}`,
        }));
        const secondPage = [{ fullName: 'Repository 501' }];

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input), 'http://localhost');
            const rows =
                url.searchParams.get('offset') === '0' ? firstPage: secondPage;

            return {
                ok: true,
                json: async () => rows,
            } as Response;
        });

        globalThis.fetch = fetchMock as typeof fetch;

        const originalClientHeight = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'clientHeight',
        );

        const originalScrollHeight = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'scrollHeight',
        );

        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            value: 500,
        });

        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            value: 2000,
        });

        try {
            render(
                <DataTable
                    title="Browse Repositories"
                    endpoint="overview/repositories"
                    scrollable
                    showRowMessage={false}
                />,
            );
            expect(await screen.findByText('Repository 1')).toBeInTheDocument();

            const container = screen.getByRole('table').parentElement!;
            container.scrollTop = 1600;
            fireEvent.scroll(container);

            expect(
                await screen.findByText('Repository 501'),
            ).toBeInTheDocument();

            const requestedUrls = fetchMock.mock.calls.map(([input]) =>
                new URL(String(input), 'http://localhost'),
            );

            expect(requestedUrls).toHaveLength(2);
            expect(requestedUrls[0].searchParams.get('limit')).toBe('500');
            expect(requestedUrls[0].searchParams.get('offset')).toBe('0');
            expect(requestedUrls[1].searchParams.get('limit')).toBe('500');
            expect(requestedUrls[1].searchParams.get('offset')).toBe('500');
        } finally {
            if(originalClientHeight) {
                Object.defineProperty(
                    HTMLElement.prototype,
                    'clientHeight',
                    originalClientHeight,
                );
            } else {
                Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
            }

            if (originalScrollHeight) {
                Object.defineProperty(
                    HTMLElement.prototype,
                    'scrollHeight',
                    originalScrollHeight,
                );
            } else {
                Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
            }
        }
    })
});
