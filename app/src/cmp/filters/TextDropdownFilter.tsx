import type { textDropdownFilterProps } from '../../types/filters';

export default function TextDropdownFilter({
    label,
    options,
    value,
    onChange,
}: textDropdownFilterProps) {
    const filteredOptions = options.filter((option) =>
        option.toLowerCase().includes(value.toLowerCase()),
    );

    return (
        <div>
            <label>{label}</label>

            <input
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                list={`${label}-options`}
            />

            <datalist id={`${label}-options`}>
                {filteredOptions.map((option) => (
                    <option key={option} value={option} />
                ))}
            </datalist>
        </div>
    );
}
