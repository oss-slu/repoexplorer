import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import SliderFilter from '../../../cmp/filters/SliderFilter';

describe('SliderFilter', () => {
    it('renders the label and current value', () => {
        render(
            <SliderFilter
                label="Stars"
                min={0}
                max={100}
                value={25}
                onChange={() => {}}
            />,
        );

        expect(screen.getByText('Stars: 25')).toBeInTheDocument();
    });

    it('calls onChange when the slider value changes', () => {
        const handleChange = vi.fn();

        render(
            <SliderFilter
                label="Stars"
                min={0}
                max={100}
                value={25}
                onChange={handleChange}
            />,
        );

        fireEvent.change(screen.getByRole('slider'), {
            target: { value: '50' },
        });

        expect(handleChange).toHaveBeenCalledWith(50);
    });
});