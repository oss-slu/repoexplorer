import { FILTERABLE_FIELDS } from '../consts';
import type { appData } from '../types/appData';

export function filterData(data: appData[], query: Record<string, unknown>): appData[] {
    return data.filter((row) =>
        Object.entries(FILTERABLE_FIELDS).every(([field, mode]) => {
            const raw = query[field];
            if (raw === undefined) return true; // no filter on this field

            const value = Array.isArray(raw) ? raw : [raw];
            const rowValue = row[field as keyof appData];

            if (mode === 'exact') {
                return value.some((v) => String(v).toLowerCase() === String(rowValue).toLowerCase());
            }
            return true;
        }),
    );
}
