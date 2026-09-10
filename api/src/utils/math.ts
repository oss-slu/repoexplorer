import type { appData } from '../types/appData';
import type { nameValueArr } from '../types/routes';

// Return summation of all values in rows of field
export function getSum(rows: appData[], field: keyof appData): number {
    let sum: number = 0;
    for (const row of rows) {
        if (typeof row[field] === 'number') sum += row[field];
    }
    return sum;
}

// Return average of all values in rows of field
export function getAvg(rows: appData[], field: keyof appData): number {
    if (rows.length === 0) return 0;
    return getSum(rows, field) / rows.length;
}

// Return the number of rows where the value in field is not null
export function getCountFieldNotNull(rows: appData[], field: keyof appData): number {
    if (rows.length === 0) return 0;
    return rows.filter((row) => row[field] !== null).length;
}

// Return the number of rows where the value of the passed field is not null
export function getPercentFieldNotNull(rows: appData[], field: keyof appData): number {
    if (rows.length === 0) return 0;
    return (getCountFieldNotNull(rows, field) / rows.length) * 100;
}

// Return a nameValueArray with each field and the percent of rows where that field is not null
export function makeFieldsNotNullArray(rows: appData[], fields: (keyof appData)[]): nameValueArr {
    return fields.map((f) => ({ name: f, value: getPercentFieldNotNull(rows, f) }));
}

// Return count of rows grouped by field. If field is not passed, return total length
function getCountsByField(rows: appData[], field?: keyof appData): Record<string, number> {
    if (!field) return { total: rows.length };

    const counts: Record<string, number> = {};
    for (const row of rows) {
        const key = row[field] || 'Unknown';
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

// Return the distribution of values in field
function getFieldDistribution(rows: appData[], field: keyof appData): Record<string, number> {
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
export function makeFieldDistributionArray(rows: appData[], field: keyof appData) {
    return makeNameValueArr(getFieldDistribution(rows, field));
}

// Return array of distributions of values in field grouped further with by (useful for stacked bar charts)
export function makeFieldDistributionByArray(rows: appData[], field: keyof appData, by: keyof appData) {
    const fieldVals = [...new Set(rows.map((row) => row[field]))];
    return fieldVals.map((val) => {
        const fieldData = rows.filter((row) => row[field] === val);
        const distData = getFieldDistribution(fieldData, by);
        return { name: String(val), ...distData };
    });
}

// Return array of counts of rows grouped by field
export function makeCountsArray(rows: appData[], field?: keyof appData): nameValueArr {
    const counts = getCountsByField(rows, field);
    return makeNameValueArr(counts);
}

export function makeNumericDistributionArray(rows: appData[], field: keyof appData) {
    const buckets: Record<string, number> = {
        '0-10': 0,
        '11-100': 0,
        '101-1000': 0,
        '1k-10k': 0,
        '10k+': 0,
    };

    for (const row of rows) {
        const value = row[field];

        if (typeof value !== 'number') continue;

        if (value < 11) buckets['0-10']++;
        else if (value < 101) buckets['11-100']++;
        else if (value < 1001) buckets['101-1000']++;
        else if (value < 10001) buckets['1k-10k']++;
        else buckets['10k+']++;
    }

    return Object.entries(buckets).map(([name, value]) => ({
        name,
        value,
    }));
}

export function makeImpactIndicatorsArray(rows: appData[]) {
    const totals = new Map<
        string,
        {
            name: string;
            stars: number;
            forks: number;
            downloads: number;
            contributors: number;
        }
    >();

    for (const row of rows) {
        const current = totals.get(row.university) ?? {
            name: row.university,
            stars: 0,
            forks: 0,
            downloads: 0,
            contributors: 0,
        };

        current.stars += row.stargazersCount;
        current.forks += row.forksCount;
        current.downloads += row.releaseDownloads;
        current.contributors += row.contributorCount;

        totals.set(row.university, current);
    }

    return [...totals.values()];
}
