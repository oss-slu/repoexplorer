import type { repoData, secrData } from '../types/appData';
import type {
    nameValueArr,
    sustainabilityCommunityFile,
    sustainabilityCommunityFileByStars,
    sustainabilityDistribution,
    sustainabilityIndicator,
} from '../types/routes';

// Return summation of all values in rows of field
export function getSum(rows: repoData[], field: keyof repoData): number {
    let sum: number = 0;
    for (const row of rows) {
        if (typeof row[field] === 'number') sum += row[field];
    }
    return sum;
}

// Return average of all values in rows of field
export function getAvg(rows: repoData[], field: keyof repoData): number {
    if (rows.length === 0) return 0;
    return getSum(rows, field) / rows.length;
}

// Return the average of finite numeric observations in field.
export function getAvailableAvg(rows: repoData[], field: keyof repoData): number {
    const availableRows = rows.filter((row) => {
        const value = row[field];
        return typeof value === 'number' && Number.isFinite(value);
    });

    return getAvg(availableRows, field);
}

// Return the number of rows where the value in field is not null
export function getCountFieldNotNull(rows: repoData[], field: keyof repoData): number {
    if (rows.length === 0) return 0;
    return rows.filter((row) => row[field] !== null).length;
}

// Return the number of rows where the value of the passed field is not null
export function getPercentFieldNotNull(rows: repoData[], field: keyof repoData): number {
    if (rows.length === 0) return 0;
    return (getCountFieldNotNull(rows, field) / rows.length) * 100;
}

// Return a nameValueArray with each field and the percent of rows where that field is not null
export function makeFieldsNotNullArray(rows: repoData[], fields: (keyof repoData)[]): nameValueArr {
    return fields.map((f) => ({ name: f, value: getPercentFieldNotNull(rows, f) }));
}

// Return count of rows grouped by field. If field is not passed, return total length
function getCountsByField(rows: repoData[], field?: keyof repoData): Record<string, number> {
    if (!field) return { total: rows.length };

    const counts: Record<string, number> = {};
    for (const row of rows) {
        const key = row[field] || 'Unknown';
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

// Return the distribution of values in field
function getFieldDistribution(rows: repoData[], field: keyof repoData): Record<string, number> {
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
export function makeFieldDistributionArray(rows: repoData[], field: keyof repoData) {
    return makeNameValueArr(getFieldDistribution(rows, field));
}

// Return array of distributions of values in field grouped further with by (useful for stacked bar charts)
export function makeFieldDistributionByArray(rows: repoData[], field: keyof repoData, by: keyof repoData) {
    const fieldVals = [...new Set(rows.map((row) => row[field]))];
    return fieldVals.map((val) => {
        const fieldData = rows.filter((row) => row[field] === val);
        const distData = getFieldDistribution(fieldData, by);
        return { name: String(val), ...distData };
    });
}

// Return array of counts of rows grouped by field
export function makeCountsArray(rows: repoData[], field?: keyof repoData): nameValueArr {
    const counts = getCountsByField(rows, field);
    return makeNameValueArr(counts);
}

export function makeNumericDistributionArray(rows: repoData[], field: keyof repoData) {
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

export function makeImpactIndicatorsArray(rows: repoData[]) {
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

export const SUSTAINABILITY_COMMUNITY_FIELDS = [
    'description',
    'readme',
    'license',
    'codeOfConductFile',
    'contributing',
    'securityPolicy',
    'issueTemplates',
    'pullRequestTemplate',
] as const satisfies readonly (keyof repoData)[];

const SUSTAINABILITY_PROJECT_TYPE_ORDER = ['DATA', 'DEV', 'DOCS', 'EDU', 'OTHER', 'WEB', 'error'];

function roundToOneDecimal(value: number): number {
    return Math.round(value * 10) / 10;
}

function orderProjectTypes(types: Set<string>): string[] {
    return [...types].sort((a, b) => {
        const aIndex = SUSTAINABILITY_PROJECT_TYPE_ORDER.indexOf(a);
        const bIndex = SUSTAINABILITY_PROJECT_TYPE_ORDER.indexOf(b);

        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
    });
}

export function makeSustainabilityIndicatorsArray(rows: repoData[]): sustainabilityIndicator[] {
    const rowsByUniversity = new Map<string, repoData[]>();

    for (const row of rows) {
        const university = row.university ?? 'Unknown';
        const universityRows = rowsByUniversity.get(university) ?? [];
        universityRows.push(row);
        rowsByUniversity.set(university, universityRows);
    }

    return [...rowsByUniversity.entries()]
        .map(([name, universityRows]) => ({
            name,
            avgContributors: getAvailableAvg(universityRows, 'contributorCount'),
            avgBusFactor: getAvailableAvg(universityRows, 'busFactor'),
        }))
        .sort((a, b) => {
            if (a.avgContributors !== b.avgContributors) return b.avgContributors - a.avgContributors;
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
}

export function makeCommunityFilesByTypeArray(rows: repoData[]): sustainabilityCommunityFile[] {
    if (rows.length === 0) return [];

    const projectTypes = orderProjectTypes(
        new Set(
            rows.map((row) => row.typePredictionGpt5Mini).filter((type): type is string => typeof type === 'string'),
        ),
    );

    return SUSTAINABILITY_COMMUNITY_FIELDS.map((field) => {
        const counts = Object.fromEntries(projectTypes.map((type) => [type, 0])) as Record<string, number>;

        for (const row of rows) {
            const projectType = row.typePredictionGpt5Mini;
            if (typeof projectType === 'string' && row[field] !== null && row[field] !== undefined) {
                counts[projectType]++;
            }
        }

        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

        return {
            name: field,
            total,
            percentage: roundToOneDecimal((total / rows.length) * 100),
            ...counts,
        };
    }).sort((a, b) => a.total - b.total);
}

type starBucketName = '0-10' | '11-50' | '51-100' | '101-200' | '>200';
type starBucket = { name: starBucketName; includes: (value: number) => boolean };

const STAR_BUCKETS: starBucket[] = [
    { name: '0-10', includes: (value) => value <= 10 },
    { name: '11-50', includes: (value) => value > 10 && value <= 50 },
    { name: '51-100', includes: (value) => value > 50 && value <= 100 },
    { name: '101-200', includes: (value) => value > 100 && value <= 200 },
    { name: '>200', includes: (value) => value > 200 },
];

function makeEmptyStarRow(name: string): sustainabilityCommunityFileByStars {
    return {
        name,
        '0-10': 0,
        '11-50': 0,
        '51-100': 0,
        '101-200': 0,
        '>200': 0,
    };
}

export function makeCommunityFilesByStarsArray(rows: repoData[]): sustainabilityCommunityFileByStars[] {
    if (rows.length === 0) return [];

    const featureRows = SUSTAINABILITY_COMMUNITY_FIELDS.map((field) => {
        const result = makeEmptyStarRow(field);

        for (const bucket of STAR_BUCKETS) {
            const bucketRows = rows.filter((row) => {
                const stars = row.stargazersCount;
                return typeof stars === 'number' && Number.isFinite(stars) && bucket.includes(stars);
            });
            const presentCount = bucketRows.filter((row) => row[field] !== null && row[field] !== undefined).length;
            result[bucket.name] =
                bucketRows.length === 0 ? 0 : roundToOneDecimal((presentCount / bucketRows.length) * 100);
        }

        return result;
    });

    const average = makeEmptyStarRow('average');
    for (const bucket of STAR_BUCKETS) {
        const fieldAverage =
            featureRows.reduce((sum, row) => sum + row[bucket.name], 0) / SUSTAINABILITY_COMMUNITY_FIELDS.length;
        average[bucket.name] = roundToOneDecimal(fieldAverage);
    }

    return [...featureRows, average];
}

type distributionBucket = { name: string; includes: (value: number) => boolean };

function makeSustainabilityDistributionArray(
    rows: repoData[],
    field: keyof repoData,
    buckets: distributionBucket[],
): sustainabilityDistribution[] {
    if (rows.length === 0) return [];

    return buckets.map(({ name, includes }) => {
        const value = rows.filter((row) => {
            const fieldValue = row[field];
            return typeof fieldValue === 'number' && Number.isFinite(fieldValue) && includes(fieldValue);
        }).length;

        return {
            name,
            value,
            percentage: roundToOneDecimal((value / rows.length) * 100),
        };
    });
}

const BUS_FACTOR_BUCKETS: distributionBucket[] = [
    { name: '0-1', includes: (value) => value >= 0 && value <= 1 },
    { name: '1-2', includes: (value) => value > 1 && value <= 2 },
    { name: '2-3', includes: (value) => value > 2 && value <= 3 },
    { name: '3-4', includes: (value) => value > 3 && value <= 4 },
    { name: '4-5', includes: (value) => value > 4 && value <= 5 },
    { name: '5-10', includes: (value) => value > 5 && value <= 10 },
    { name: '10+', includes: (value) => value > 10 },
];

const CONTRIBUTOR_COUNT_BUCKETS: distributionBucket[] = [
    { name: '0-2', includes: (value) => value >= 0 && value <= 2 },
    { name: '3-10', includes: (value) => value >= 3 && value <= 10 },
    { name: '10-50', includes: (value) => value > 10 && value <= 50 },
    { name: '50-100', includes: (value) => value > 50 && value <= 100 },
    { name: '100+', includes: (value) => value > 100 },
];

export function makeBusFactorDistributionArray(rows: repoData[]): sustainabilityDistribution[] {
    return makeSustainabilityDistributionArray(rows, 'busFactor', BUS_FACTOR_BUCKETS);
}

export function makeContributorCountDistributionArray(rows: repoData[]): sustainabilityDistribution[] {
    return makeSustainabilityDistributionArray(rows, 'contributorCount', CONTRIBUTOR_COUNT_BUCKETS);
}

export function makeAvgScorePerMetricArray(rows: secrData[]): nameValueArr {
    const fields = Object.keys(rows[0] ?? {}).filter((field) => field !== 'htmlUrl') as (keyof secrData)[];

    return fields.map((field) => {
        const scores = rows
            .map((row) => row[field])
            .filter((value): value is number => typeof value === 'number' && value !== -1);

        const value = scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length;

        return {
            name: field,
            value,
        };
    });
}
