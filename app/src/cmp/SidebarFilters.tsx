import { useState } from 'react';
import SliderFilter from './filters/SliderFilter';
import TextDropdownFilter from './filters/TextDropdownFilter';

type SliderFilterConfig = {
    key: string;
    label: string;
    type: 'slider';
    min: number;
    max: number;
};

type TextFilterConfig = {
    key: string;
    label: string;
    type: 'text';
    options: string[];
};

type FilterConfig = SliderFilterConfig | TextFilterConfig;

type SidebarFiltersProps = {
    filters: FilterConfig[];
};

export default function SidebarFilters({ filters }: SidebarFiltersProps) {
    const [filterValues, setFilterValues] = useState<
        Record<string, string | number>
    >({});

    return (
        <aside>
            {filters.map((filter) => {
                const currentValue = filterValues[filter.key];

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
                                    : filter.min
                            }
                            onChange={(value) =>
                                setFilterValues((previousValues) => ({
                                    ...previousValues,
                                    [filter.key]: value,
                                }))
                            }
                        />
                    );
                }

                return (
                    <TextDropdownFilter
                        key={filter.key}
                        label={filter.label}
                        options={filter.options}
                        value={
                            typeof currentValue === 'string' ? currentValue : ''
                        }
                        onChange={(value) =>
                            setFilterValues((previousValues) => ({
                                ...previousValues,
                                [filter.key]: value,
                            }))
                        }
                    />
                );
            })}

            <button type="button" onClick={() => setFilterValues({})}>
                Reset
            </button>
        </aside>
    );
}
