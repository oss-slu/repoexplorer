import type { parquetData } from '../types/parquetData';
import type { nameValueArr } from '../types/routes';

// Return summation of all values in rows of field
export function getSum(rows: parquetData[], field: keyof parquetData): number {
    let sum: number = 0; 
    for (const row of rows) {
        if (typeof row[field] === 'number') sum += row[field];
    }
    return sum;
}

// Return average of all values in rows of field
export function getAvg(rows: parquetData[], field: keyof parquetData): number {
    if (rows.length === 0) return 0;
    return getSum(rows, field) / rows.length;
}

// Return the number of rows where the value in field is not null
export function getCountFieldNotNull(rows: parquetData[], field: keyof parquetData): number {
    if (rows.length === 0) return 0;
    return rows.filter(row => row[field] !== null).length;
}

// Return the number of rows where the value of the passed field is not null
export function getPercentFieldNotNull(rows: parquetData[], field: keyof parquetData): number {
    if (rows.length === 0) return 0;
    return (getCountFieldNotNull(rows, field) / rows.length) * 100;
}


// Return a nameValueArray with each field and the percent of rows where that field is not null
export function makeFieldsNotNullArray(rows: parquetData[], fields: (keyof parquetData)[]): nameValueArr {
    return fields.map(f => ({ name: f, value: getPercentFieldNotNull(rows, f)}));
}

// Return count of rows grouped by field. If field is not passed, return total length
function getCountsByField(rows: parquetData[], field?: keyof parquetData): Record<string, number> { 
    if (!field) return { total: rows.length };

    const counts: Record<string, number> = {};
    for (const row of rows) {
        const key = row[field] || 'Unknown';
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

// Return the distribution of values in field
function getFieldDistribution(rows: parquetData[], field: keyof parquetData): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const [key, count] of Object.entries(getCountsByField(rows, field))) {
        dist[key] = count / rows.length;
    }
    return dist;
}

// Convert Record<string, number> to nameValueArr
function makeNameValueArr(data: Record<string, number>): nameValueArr {
    return Object.entries(data).map(([name, value]) => ({ name, value }));
}

// Return array of distributions of values grouped by field
export function makeFieldDistributionArray(rows: parquetData[], field: keyof parquetData) {
    return makeNameValueArr(getFieldDistribution(rows, field));
}

// Return array of distributions of values in field grouped further with by (useful for stacked bar charts)
export function makeFieldDistributionByArray(rows: parquetData[], field: keyof parquetData, by: keyof parquetData) {
    const fieldVals = [...new Set(rows.map(row => row[field]))];
    return fieldVals.map(val => {
        const fieldData = rows.filter(row => row[field] === val);
        const distData = getFieldDistribution(fieldData, by);
        return { name: String(val), ...distData };
    });
}

// Return array of counts of rows grouped by field
export function makeCountsArray(rows: parquetData[], field?: keyof parquetData): nameValueArr {
    const counts = getCountsByField(rows, field);
    return makeNameValueArr(counts);
}