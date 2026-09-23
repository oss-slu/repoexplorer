import { fireEvent, render, screen } from '@testing-library/react';
import SidebarFilters from '../../cmp/SidebarFilters';

describe('SidebarFilters', () => {
    const filters = [
        {
            key: 'stars',
            label: 'Stars',
            type: 'slider' as const,
            min: 0,
            max: 100,
        },
        {
            key: 'language',
            label: 'Language',
            type: 'text' as const,
            options: ['JavaScript', 'Python', 'Java'],
        },
    ];

    it('renders different filter types', () => {
        render(<SidebarFilters filters={filters} />);

        expect(screen.getByText('Stars: 0')).toBeInTheDocument();
        expect(screen.getByText('Language')).toBeInTheDocument();
        expect(screen.getByRole('slider')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'Reset' }),
        ).toBeInTheDocument();
    });

    it('uses the provided default values', () => {
        const filtersWithDefaults = [
            {
                key: 'stars',
                label: 'Stars',
                type: 'slider' as const,
                min: 0,
                max: 100,
                defaultValue: 25,
            },
            {
                key: 'language',
                label: 'Language',
                type: 'text' as const,
                options: ['JavaScript', 'Python', 'Java'],
                defaultValue: 'Python',
            },
        ];

        render(<SidebarFilters filters={filtersWithDefaults} />);

        expect(screen.getByText('Stars: 25')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveValue('Python');
    });

    it('resets to the provided default values', () => {
        const filtersWithDefaults = [
            {
                key: 'stars',
                label: 'Stars',
                type: 'slider' as const,
                min: 0,
                max: 100,
                defaultValue: 25,
            },
            {
                key: 'language',
                label: 'Language',
                type: 'text' as const,
                options: ['JavaScript', 'Python', 'Java'],
                defaultValue: 'Python',
            },
        ];

        render(<SidebarFilters filters={filtersWithDefaults} />);

        fireEvent.change(screen.getByRole('slider'), {
            target: { value: '50' },
        });

        fireEvent.change(screen.getByRole('combobox'), {
            target: { value: 'Java' },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

        expect(screen.getByText('Stars: 25')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveValue('Python');
    });

    it('updates the filter values when they change', () => {
        render(<SidebarFilters filters={filters} />);

        fireEvent.change(screen.getByRole('slider'), {
            target: { value: '50' },
        });

        expect(screen.getByText('Stars: 50')).toBeInTheDocument();

        fireEvent.change(screen.getByRole('combobox'), {
            target: { value: 'Python' },
        });

        expect(screen.getByRole('combobox')).toHaveValue('Python');
    });

    it('resets the filter values', () => {
        render(<SidebarFilters filters={filters} />);

        fireEvent.change(screen.getByRole('slider'), {
            target: { value: '50' },
        });

        fireEvent.change(screen.getByRole('combobox'), {
            target: { value: 'Python' },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

        expect(screen.getByText('Stars: 0')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveValue('JavaScript');
    });
});
