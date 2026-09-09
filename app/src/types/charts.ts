import type { ReactNode } from 'react';

export type pieSlice = { name: string; value: number; fill?: string };
export type chartProps = { title?: string; endpoint?: string };
export type dataBlockProps = {
    header: string;
    value: string | number;
    icon?: ReactNode;
};
