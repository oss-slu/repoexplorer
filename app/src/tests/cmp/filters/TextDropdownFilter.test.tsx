import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import TextDropdownFilter from '../../../cmp/filters/TextDropdownFilter';

describe('TextDropdownFilter', () => {
    it('renders the label and input', () => {
        render(
            <TextDropdownFilter
                label="Language"
                options={['JavaScript', 'Python', 'Java']}
                value=""
                onChange={() => {}}
            />,
        );

        expect(screen.getByText('Language')).toBeInTheDocument();
        expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('calls onChange when the user types', () => {
        const handleChange = vi.fn();

        render(
            <TextDropdownFilter
                label="Language"
                options={['JavaScript', 'Python', 'Java']}
                value=""
                onChange={handleChange}
            />,
        );

        fireEvent.change(screen.getByRole('combobox'), {
            target: { value: 'Python' },
        });

        expect(handleChange).toHaveBeenCalledWith('Python');
    });

    it('filters the suggested options based on the current value', () => {
        const { container } = render(
            <TextDropdownFilter
                label="Language"
                options={['JavaScript', 'Python', 'Java']}
                value="Java"
                onChange={() => {}}
            />,
        );

        const options = Array.from(
            container.querySelectorAll('datalist option'),
        ).map((option) => option.getAttribute('value'));

        expect(options).toContain('JavaScript');
        expect(options).toContain('Java');
        expect(options).not.toContain('Python');
    });
});