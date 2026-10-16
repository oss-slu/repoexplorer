import type { sliderFilterProps } from '../../types/filters';

export default function SliderFilter({
    label,
    min,
    max,
    value,
    onChange,
}: sliderFilterProps) {
    return (
        <div>
            <label>
                {label}: {value}
            </label>

            <input
                type="range"
                min={min}
                max={max}
                step={max <= 1 ? 0.1 : 1}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
            />
        </div>
    );
}
