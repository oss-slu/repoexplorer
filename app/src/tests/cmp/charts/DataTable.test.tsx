import { render, screen, within } from '@testing-library/react';
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
});
