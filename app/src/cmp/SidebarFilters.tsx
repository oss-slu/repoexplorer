import type { sidebarFiltersProps } from '../types/filters';
import SliderFilter from './filters/SliderFilter';
import TextDropdownFilter from './filters/TextDropdownFilter';

export default function SidebarFilters({
    filters,
    values,
    onChange,
    onReset,
}: sidebarFiltersProps) {
    return (
        <aside>
            {filters.map((filter) => {
                const currentValue = values[filter.key];

                if (filter.type === 'slider') {
                    return (
                        <SliderFilter
                            key={filter.key}
                            label={filter.label}
                            min={filter.min}
                            max={filter.max}
                            value={
                                typeof currentValue === 'number'
                                    ? currentValue
                                    : (filter.defaultValue ?? 0)
                            }
                            onChange={(value) => onChange(filter.key, value)}
                        />
                    );
                }

                return (
                    <TextDropdownFilter
                        key={filter.key}
                        label={filter.label}
                        options={filter.options}
                        value={
                            typeof currentValue === 'string'
                                ? currentValue
                                : (filter.defaultValue ??
                                  filter.options[0] ??
                                  '')
                        }
                        onChange={(value) => onChange(filter.key, value)}
                    />
                );
            })}

            <button type="button" onClick={() => onReset()}>
                Reset
            </button>
        </aside>
    );
}
