import type { filterMode } from '../types/appData';

export function filterData<T extends Record<string, unknown>>(
    data: T[],
    query: Record<string, unknown>,
    filterableFields: Partial<Record<keyof T, filterMode>>,
): T[] {
    return data.filter((row) =>
        (Object.entries(filterableFields) as [keyof T, filterMode][]).every(([field, mode]) => {
            const raw = query[field as string];
            if (raw === undefined) return true; // no filter on this field

            const value = Array.isArray(raw) ? raw : [raw];
            const rowValue = row[field as keyof T];

            if (mode === 'exact') {
                return value.some((v) => String(v).toLowerCase() === String(rowValue).toLowerCase());
            }
            return true;
        }),
    );
}
