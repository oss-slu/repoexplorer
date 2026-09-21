type SliderFilterProps = {
    label: string;
    min: number;
    max: number;
    value: number;
    onChange: (value: number) => void;
};

export default function SliderFilter({
    label,
    min,
    max,
    value,
    onChange,
}: SliderFilterProps) {
    return (
        <div>
            <label>
                {label}: {value}
            </label>

            <input
                type="range"
                min={min}
                max={max}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
            />
        </div>
    );
}