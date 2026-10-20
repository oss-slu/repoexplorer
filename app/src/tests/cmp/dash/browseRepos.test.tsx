import { render, screen, fireEvent } from '@testing-library/react';
import BrowseRepos from '../../../cmp/dash/browseRepos';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../cmp/charts/DataTable', () => ({
    default: ({ title, onRowClick }: any) => (
        <div data-testid="mock-datatable">
            <h2>{title}</h2>
            <button 
                data-testid="mock-row-click" 
                onClick={() => onRowClick({ name: 'Test University', readme: 'Test README content' })}
            >
                Click Mock Row
            </button>
        </div>
    )
}));

describe('Browse Repositories Dashboard', () => {
    it('renders the data table on initial load', () => {
        render(<BrowseRepos />);
        expect(screen.getByText('Browse Repositories')).toBeInTheDocument();
        expect(screen.queryByText(/Row-Level Dashboard/i)).not.toBeInTheDocument();
    });

    it('displays the row-level dashboard when a row is clicked', () => {
        render(<BrowseRepos />);
        fireEvent.click(screen.getByTestId('mock-row-click'));
        
        expect(screen.getByText('Row-Level Dashboard: Test University')).toBeInTheDocument();
        expect(screen.getByText('Test README content')).toBeInTheDocument();
        expect(screen.getByText('No security metrics available')).toBeInTheDocument();
        expect(screen.getByText(/Currently viewing the/i)).toBeInTheDocument();
    });
});