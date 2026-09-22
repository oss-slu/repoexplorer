export type sliderFilterConfig = {
    key: string;
    label: string;
    type: 'slider';
    min: number;
    max: number;
    defaultValue?: number;
};

export type textFilterConfig = {
    key: string;
    label: string;
    type: 'text';
    options: string[];
    defaultValue?: string;
};

export type filterConfig = sliderFilterConfig | textFilterConfig;

export type sidebarFiltersProps = {
    filters: filterConfig[];
};

export type sliderFilterProps = {
    label: string;
    min: number;
    max: number;
    value: number;
    onChange: (value: number) => void;
};

export type textDropdownFilterProps = {
    label: string;
    options: string[];
    value: string;
    onChange: (value: string) => void;
};
