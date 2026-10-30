import type { ReactNode } from 'react';

export type pieSlice = { name: string; value: number; fill?: string };

export type chartProps = {
    title?: string;
    endpoint?: string;
    queryString?: string;
    stacked?: boolean;
    horizontal?: boolean;
    seriesKeys?: string[];
    seriesLabels?: string[];
    maxRows?: number;
    xLabel?: string;
    yLabel?: string;
    valueSuffix?: string;
};
export type barDatum = {
    name: string;
    [key: string]: string | number;
};

export type dataBlockProps = {
    header: string;
    value: string | number;
    icon?: ReactNode;
};
