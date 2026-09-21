type TextDropdownFilterProps = {
    label: string;
    options: string[];
    value: string;
    onChange: (value: string) => void;
};

export default function TextDropdownFilter({
    label,
    options,
    value,
    onChange,
}: TextDropdownFilterProps) {
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