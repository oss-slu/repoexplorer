import type { parquetData } from '../types/parquetData';
import type { nameValueArr } from '../types/routes';

export function getUniqueCount(rows: parquetData[], field?: keyof parquetData): number {
    if (!field) return rows.length;
    return [...new Map(rows.map(row => [row[field], row])).values()].length;
}

export function getSum(rows: parquetData[], field: keyof parquetData): number {
    let sum: number = 0; 
    for (const row of rows) {
        if (typeof row[field] === 'number') sum += row[field];
    }
    return sum;
}

export function getAvg(rows: parquetData[], field: keyof parquetData): number {
    if (rows.length === 0) return 0;
    return getSum(rows, field) / rows.length;
}

export function getPercentFieldNotNull(rows: parquetData[], field: keyof parquetData): number {
    if (rows.length === 0) return 0;
    const trueCount = rows.filter(row => row[field] !== null).length;
    return (trueCount / rows.length) * 100;
}

/* 
    Accept an array of fields, return a nameValueArray with an entry for each field and the percent of rows where that
    field is not null
*/
export function makeFieldsNotNullArray(rows: parquetData[], fields: (keyof parquetData)[]): nameValueArr {
    return fields.map(f => ({ name: f, value: getPercentFieldNotNull(rows, f)}));
}

/*
    Returns count of rows grouped by the passed field. If field is not passed, returns total length
*/ 
export function getCounts(rows: parquetData[], field?: keyof parquetData): Record<string, number> { 
    if (!field) {
        return { total: rows.length };
    }
    const counts: Record<string, number> = {};
    for (const row of rows) {
        const key = row[field] || 'Unknown';
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

/* 
    Calculate distribution of the values in the field passed to keyFn (mostly used for pie charts)
*/
export function getDistribution(rows: parquetData[], field: keyof parquetData): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const [key, count] of Object.entries(getCounts(rows, field))) {
        dist[key] = count / rows.length;
    }
    return dist;
}

/* 
    Convert map of string, number to nameValueArr type
*/
export function makeNameValueArr(data: Record<string, number>): nameValueArr {
    return Object.entries(data).map(([name, value]) => ({ name, value }));
}

/* 
    Create an array of distributions
*/
export function makeDistributionArray(data: parquetData[], field: keyof parquetData) {
    const distData = getDistribution(data, field);
    return makeNameValueArr(distData);
}

/* 
    Create an array of distributions by another field
*/
export function makeDistributionByArray(data: parquetData[], field: keyof parquetData, by: keyof parquetData) {
    const fieldVals = [...new Set(data.map(row => row[field]))];
    return fieldVals.map(val => {
        const fieldData = data.filter(row => row[field] === val);
        const distData = getDistribution(fieldData, by);
        return { name: String(val), ...distData };
    });
}

/*
    Create an array of counts
*/
export function makeCountsArray(data: parquetData[], field?: keyof parquetData) {
    const counts = getCounts(data, field);
    return makeNameValueArr(counts);
}

