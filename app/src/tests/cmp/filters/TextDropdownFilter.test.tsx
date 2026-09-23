import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import TextDropdownFilter from '../../../cmp/filters/TextDropdownFilter';

describe('TextDropdownFilter', () => {
    it('renders the label and select', () => {
        render(
            <TextDropdownFilter
                label="Language"
                options={['JavaScript', 'Python', 'Java']}
                value="JavaScript"
                onChange={() => {}}
            />,
        );

        expect(screen.getByText('Language')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('calls onChange when the user selects an option', () => {
        const handleChange = vi.fn();

        render(
            <TextDropdownFilter
                label="Language"
                options={['JavaScript', 'Python', 'Java']}
                value="JavaScript"
                onChange={handleChange}
            />,
        );

        fireEvent.change(screen.getByRole('combobox'), {
            target: { value: 'Python' },
        });

        expect(handleChange).toHaveBeenCalledWith('Python');
    });

    it('renders the provided options', () => {
        render(
            <TextDropdownFilter
                label="Language"
                options={['JavaScript', 'Python', 'Java']}
                value="JavaScript"
                onChange={() => {}}
            />,
        );

        expect(
            screen.getByRole('option', { name: 'JavaScript' }),
        ).toBeInTheDocument();

        expect(
            screen.getByRole('option', { name: 'Python' }),
        ).toBeInTheDocument();

        expect(
            screen.getByRole('option', { name: 'Java' }),
        ).toBeInTheDocument();
    });
});
