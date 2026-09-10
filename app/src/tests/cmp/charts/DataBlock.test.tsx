import { render, screen } from '@testing-library/react';
import DataBlock from '../../../cmp/charts/DataBlock';

describe('DataBlock', () => {
    it('renders the header and value', () => {
        render(<DataBlock header="Total repositories" value={129101} />);

        expect(screen.getByText('Total repositories')).toBeInTheDocument();
        expect(screen.getByText('129101')).toBeInTheDocument();
    });

    it('renders an icon when one is provided', () => {
        render(
            <DataBlock
                header="Total repositories"
                value={129101}
                icon={<span data-testid="data-block-icon">Icon</span>}
            />,
        );

        expect(screen.getByTestId('data-block-icon')).toBeInTheDocument();
    });

    it('renders without an icon when one is not provided', () => {
        render(<DataBlock header="Total repositories" value={129101} />);

        expect(screen.queryByTestId('data-block-icon')).not.toBeInTheDocument();
    });
});
