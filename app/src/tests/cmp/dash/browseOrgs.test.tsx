
import { render, screen, fireEvent } from '@testing-library/react';
import BrowseOrgs from '../../../cmp/dash/browseOrgs';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../cmp/charts/DataTable', () => ({
    default: ({ title, onRowClick, filters }: any) => (
        <div data-testid="mock-datatable">
            <h2>{title}</h2>
            <span data-testid="mock-filters">
                {JSON.stringify(filters)}
            </span>
            <button
                data-testid="mock-row-click"
                onClick={() =>
                    onRowClick({
                        login: 'test-organization',
                        name: 'Test Organization',
                        university: 'Saint Louis University',
                        url: 'https://example.com',
                        description: 'Test organization description',
                        email: null,
                    })
                }
            >
                Click Mock Row
            </button>
        </div>
    ),
}));

describe('Browse Organizations Dashboard', () => {
    it('renders the data table on initial load', () => {
        render(<BrowseOrgs />);

        expect(
            screen.getByText('Browse Organizations'),
        ).toBeInTheDocument();

        expect(
            screen.queryByText('Organization Details'),
        ).not.toBeInTheDocument();
    });

    it('displays organization details when a row is clicked', () => {
        render(<BrowseOrgs />);

        fireEvent.click(screen.getByTestId('mock-row-click'));

        expect(
            screen.getByText('Organization Details'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Test Organization'),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Saint Louis University'),
        ).toBeInTheDocument();
    });

    it('displays whether URL, description, and email exist', () => {
        render(<BrowseOrgs />);

        fireEvent.click(screen.getByTestId('mock-row-click'));

        expect(
            screen.getByText('URL Exists:').parentElement,
        ).toHaveTextContent('URL Exists: Yes');

        expect(
            screen.getByText('Description Exists:').parentElement,
        ).toHaveTextContent('Description Exists: Yes');

        expect(
            screen.getByText('Email Exists:').parentElement,
        ).toHaveTextContent('Email Exists: No');
    });

    it('passes organization filters to the data table', () => {
        const filters = {
            university: ['GWU'],
            affiliationPredictionOrgs: 0.5,
        };

        render(<BrowseOrgs filters={filters} />);

        expect(
            screen.getByTestId('mock-filters'),
        ).toHaveTextContent(JSON.stringify(filters));
    });
});
