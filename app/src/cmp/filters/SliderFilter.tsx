import type { sliderFilterProps } from '../../types/filters';

export default function SliderFilter({
    label,
    min,
    max,
    value,
    onChange,
}: sliderFilterProps) {
    // Calculate where the selected value should appear above the slider
    const percentage = max > min ? ((value - min) / (max - min)) * 100 : 0;
    const position = Math.min(100, Math.max(0, percentage));

    const formatValue = (number: number) => number.toLocaleString();

    return (
        <div className="slider-filter">
            <label className="slider-filter-label">{label}</label>

            <div className="slider-filter-values">
                <span className="slider-filter-min">{formatValue(min)}</span>
                <span className="slider-filter-max">{formatValue(max)}</span>
            </div>

            <div className="slider-filter-current-row">
                <span
                    className="slider-filter-current"
                    style={{ left: `calc(8px + (100% - 16px) * ${position / 100})` }}
                >
                    {formatValue(value)}
                </span>
            </div>

            <input
                className="slider-filter-input"
                type="range"
                min={min}
                max={max}
                step={max <= 1 ? 0.1 : 1}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                style={{
                    background: `linear-gradient(to right, #007bba ${position}%, #dee2e6 ${position}%)`,
                }}
                aria-label={label}
            />
        </div>
    );
}