import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import SidebarFilters from '../../cmp/SidebarFilters';
import type { filterConfig } from '../../types/filters';

describe('SidebarFilters', () => {
    const filters: filterConfig[] = [
        {
            key: 'stars',
            label: 'Stars',
            type: 'slider',
            min: 0,
            max: 100,
        },
        {
            key: 'language',
            label: 'Language',
            type: 'text',
            options: ['JavaScript', 'Python', 'Java'],
        },
    ];

    const filtersWithDefaults: filterConfig[] = [
        {
            key: 'stars',
            label: 'Stars',
            type: 'slider',
            min: 0,
            max: 100,
            defaultValue: 25,
        },
        {
            key: 'language',
            label: 'Language',
            type: 'text',
            options: ['JavaScript', 'Python', 'Java'],
            defaultValue: 'Python',
        },
    ];

    function TestSidebar({ filters }: { filters: filterConfig[] }) {
        const getDefaults = () => {
            const defaults: Record<string, string | number> = {};

            filters.forEach((filter) => {
                defaults[filter.key] =
                    filter.defaultValue ??
                    (filter.type === 'slider' ? 0 : (filter.options[0] ?? ''));
            });

            return defaults;
        };

        const [values, setValues] =
            useState<Record<string, string | number>>(getDefaults);

        return (
            <SidebarFilters
                filters={filters}
                values={values}
                onChange={(key, value) =>
                    setValues((previous) => ({
                        ...previous,
                        [key]: value,
                    }))
                }
                onReset={() => setValues(getDefaults())}
            />
        );
    }

    it('renders different filter types', () => {
        render(<TestSidebar filters={filters} />);

        expect(screen.getByText('Stars: 0')).toBeInTheDocument();
        expect(screen.getByText('Language')).toBeInTheDocument();
        expect(screen.getByRole('slider')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'Reset' }),
        ).toBeInTheDocument();
    });

    it('uses the provided default values', () => {
        render(<TestSidebar filters={filtersWithDefaults} />);

        expect(screen.getByText('Stars: 25')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toHaveValue('Python');
    });

    it('resets to the provided default values', () => {
        render(<TestSidebar filters={filtersWithDefaults} />);

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
        render(<TestSidebar filters={filters} />);

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
        render(<TestSidebar filters={filters} />);

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
