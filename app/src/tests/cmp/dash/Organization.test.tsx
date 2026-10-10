import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Organization from '../../../cmp/dash/Organization';

vi.mock('../../../cmp/charts/BarChartDiv', () => ({
    default: ({ title }: { title?: string }) => <div>{title}</div>,
}));

describe('Organization', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the Organization dashboard', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                totalOrganizations: 100,
                percentOrganizationsURL: 55.00000000000001,
                percentOrganizationsDescription: 76,
                percentOrganizationsEmail: 35,
            }),
        } as Response);

        render(<Organization />);

        await waitFor(() => {
            expect(screen.getByText('Total Organizations')).toBeInTheDocument();
        });

        expect(screen.getByText('100')).toBeInTheDocument();

        expect(screen.getByText('With URL')).toBeInTheDocument();
        expect(screen.getByText('55.0%')).toBeInTheDocument();

        expect(
            screen.getByText('With Description'),
        ).toBeInTheDocument();
        expect(screen.getByText('76.0%')).toBeInTheDocument();

        expect(screen.getByText('With Email')).toBeInTheDocument();
        expect(screen.getByText('35.0%')).toBeInTheDocument();

        expect(
            screen.getByText('Organizations Per University'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Organizations Created Per Year'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Profile Completeness'),
        ).toBeInTheDocument();
    });

    it('shows an error message when the Organization request fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
        } as Response);

        render(<Organization />);

        expect(
            await screen.findByText(
                'Failed to load organization: Error fetching organization: 500',
            ),
        ).toBeInTheDocument();
    });
});
