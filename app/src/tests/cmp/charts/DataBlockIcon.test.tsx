import { render } from '@testing-library/react';
import DataBlockIcon from '../../../cmp/charts/DataBlockIcon';

describe('DataBlockIcon', () => {
    const iconNames = [
        'repository',
        'contributors',
        'license',
        'bus-factor',
        'stars',
        'forks',
        'downloads',
        'organizations',
        'url',
        'description',
        'email',
    ] as const;

    it.each(iconNames)('renders the %s SVG icon', (name) => {
        const { container } = render(<DataBlockIcon name={name} />);

        const svg = container.querySelector('svg');

        expect(svg).toBeInTheDocument();
        expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
        expect(svg).toHaveAttribute('aria-hidden', 'true');
        expect(svg?.children.length).toBeGreaterThan(0);
    });

    it('renders a filled star icon', () => {
        const { container } = render(<DataBlockIcon name="stars" />);

        const star = container.querySelector('path');

        expect(star).toHaveAttribute('fill', 'currentColor');
    });

    it('renders three people for the contributors icon', () => {
        const { container } = render(
            <DataBlockIcon name="contributors" />,
        );

        const heads = container.querySelectorAll('circle');

        expect(heads).toHaveLength(3);
    });
});