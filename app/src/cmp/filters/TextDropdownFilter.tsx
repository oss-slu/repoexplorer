import type { textDropdownFilterProps } from '../../types/filters';

export default function TextDropdownFilter({
    label,
    options,
    value,
    onChange,
}: textDropdownFilterProps) {
    return (
        <div>
            <label>{label}</label>

            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
            >
                {options.map((option) => (
                    <option key={option} value={option}>
                        {option}
                    </option>
                ))}
            </select>
        </div>
    );
}
