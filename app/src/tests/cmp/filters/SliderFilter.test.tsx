import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import SliderFilter from '../../../cmp/filters/SliderFilter';

describe('SliderFilter', () => {
    it('renders the label, minimum, maximum, and current value', () => {
        const { container } = render(
            <SliderFilter
                label="Stars"
                min={0}
                max={100}
                value={25}
                onChange={() => {}}
            />,
        );

        expect(screen.getByText('Stars')).toBeInTheDocument();
        expect(container.querySelector('.slider-filter-min')).toHaveTextContent('0');
        expect(container.querySelector('.slider-filter-max')).toHaveTextContent('100');
        expect(container.querySelector('.slider-filter-current')).toHaveTextContent('25');
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

    it('positions the current value based on the slider value', () => {
        const { container } = render(
            <SliderFilter
                label="Forks"
                min={0}
                max={100}
                value={50}
                onChange={() => {}}
            />,
        );

        const currentValue = container.querySelector('.slider-filter-current');

        expect(currentValue).toHaveStyle({
            left: 'calc(8px + (100% - 16px) * 0.5)',
        });
    });

    it('shades the unselected portion of the slider', () => {
        render(
            <SliderFilter
                label="Forks"
                min={0}
                max={100}
                value={50}
                onChange={() => {}}
            />,
        );

        expect(screen.getByRole('slider')).toHaveStyle({
            background: 'linear-gradient(to right, #007bba 50%, #dee2e6 50%)',
        });
    });

    it('displays large numbers with commas', () => {
        const { container } = render(
            <SliderFilter
                label="Release Downloads"
                min={0}
                max={10000}
                value={2500}
                onChange={() => {}}
            />,
        );

        expect(container.querySelector('.slider-filter-max')).toHaveTextContent('10,000');
        expect(container.querySelector('.slider-filter-current')).toHaveTextContent('2,500');
    });

    it('keeps the current value positioned within the slider range', () => {
        const { container, rerender } = render(
            <SliderFilter
                label="Forks"
                min={0}
                max={500}
                value={0}
                onChange={() => {}}
            />,
        );

        const currentValue = container.querySelector('.slider-filter-current');

        expect(currentValue).toHaveStyle({
            left: 'calc(8px + (100% - 16px) * 0)',
        });

        rerender(
            <SliderFilter
                label="Forks"
                min={0}
                max={500}
                value={500}
                onChange={() => {}}
            />,
        );

        expect(currentValue).toHaveStyle({
            left: 'calc(8px + (100% - 16px) * 1)',
        });
    });
});