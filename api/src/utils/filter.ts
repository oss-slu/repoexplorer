import type { parquetData } from '../types/parquetData';

const FILTERABLE_FIELDS: Partial<Record<keyof parquetData, 'exact' | 'includes'>> = {
    university: 'exact',
    language: 'exact',
    license: 'exact',
    typePredictionGpt5Mini: 'exact',
};

export function filterData(data: parquetData[], query: Record<string, unknown>): parquetData[] {
    return data.filter((row) =>
        Object.entries(FILTERABLE_FIELDS).every(([field, mode]) => {
            const raw = query[field];
            if (raw === undefined) return true; // no filter on this field

            const value = Array.isArray(raw) ? raw : [raw];
            const rowValue = row[field as keyof parquetData];

            if (mode === 'exact') {
                return value.some((v) => String(v).toLowerCase() === String(rowValue).toLowerCase());
            }
            return true;
        }),
    );
}