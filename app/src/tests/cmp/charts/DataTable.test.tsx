import { render, screen } from '@testing-library/react';
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
            { name: 'Saint Louis University', repositories: 275 },
            { name: 'University of California, Santa Cruz', repositories: 150 },
        ];

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve(mockData),
            } as Response),
        );

        render(<DataTable title="Universities" endpoint="universities" />);

        // headers
        expect(await screen.findByText('name')).toBeInTheDocument();
        expect(await screen.findByText('repositories')).toBeInTheDocument();

        // rows
        expect(
            await screen.findByText('Saint Louis University'),
        ).toBeInTheDocument();
        expect(await screen.findByText('275')).toBeInTheDocument();
        expect(
            await screen.findByText('University of California, Santa Cruz'),
        ).toBeInTheDocument();
        expect(await screen.findByText('150')).toBeInTheDocument();
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
