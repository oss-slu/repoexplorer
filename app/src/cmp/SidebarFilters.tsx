import { useState } from 'react';
import type { sidebarFiltersProps } from '../types/filters';
import SliderFilter from './filters/SliderFilter';
import TextDropdownFilter from './filters/TextDropdownFilter';

export default function SidebarFilters({ filters }: sidebarFiltersProps) {
    const getDefaultValues = () => {
        const defaultValues: Record<string, string | number> = {};

        filters.forEach((filter) => {
            if (filter.type === 'slider') {
                defaultValues[filter.key] = filter.defaultValue ?? 0;
            } else {
                defaultValues[filter.key] =
                    filter.defaultValue ?? filter.options[0] ?? '';
            }
        });

        return defaultValues;
    };

    const [filterValues, setFilterValues] =
        useState<Record<string, string | number>>(getDefaultValues());

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
                                    : (filter.defaultValue ?? 0)
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
                            typeof currentValue === 'string'
                                ? currentValue
                                : (filter.defaultValue ??
                                  filter.options[0] ??
                                  '')
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

            <button
                type="button"
                onClick={() => setFilterValues(getDefaultValues())}
            >
                Reset
            </button>
        </aside>
    );
}
