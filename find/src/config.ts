import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
    ScrapingConfiguration,
    SearchQueries,
    UniversityConfiguration,
} from './types/scraping';

const DEFAULT_REPOSITORY_CONCURRENCY = 4;
const DEFAULT_DATABASE_BATCH_SIZE = 100;

export async function loadScrapingConfiguration(
    configPath: string,
): Promise<ScrapingConfiguration> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
        throw new Error(
            `Could not read scraping configuration at ${path.resolve(configPath)}`,
            { cause: error },
        );
    }
    return validateScrapingConfiguration(parsed);
}

export function validateScrapingConfiguration(
    value: unknown,
): ScrapingConfiguration {
    if (!isRecord(value) || !Array.isArray(value.universities)) {
        throw new TypeError('Configuration must contain a universities array');
    }
    if (value.universities.length === 0) {
        throw new TypeError(
            'Configuration must include at least one university',
        );
    }

    const universities = value.universities.map((university, index) =>
        validateUniversity(university, index),
    );
    const keys = new Set<string>();
    for (const university of universities) {
        const normalized = university.key.toLocaleLowerCase('en-US');
        if (keys.has(normalized)) {
            throw new TypeError(
                `University key is duplicated: ${university.key}`,
            );
        }
        keys.add(normalized);
    }

    return {
        universities,
        repositoryConcurrency: readBoundedInteger(
            value.repositoryConcurrency,
            DEFAULT_REPOSITORY_CONCURRENCY,
            'repositoryConcurrency',
            1,
            16,
        ),
        databaseBatchSize: readBoundedInteger(
            value.databaseBatchSize,
            DEFAULT_DATABASE_BATCH_SIZE,
            'databaseBatchSize',
            1,
            500,
        ),
    };
}

function validateUniversity(
    value: unknown,
    index: number,
): UniversityConfiguration {
    if (!isRecord(value)) {
        throw new TypeError(`universities[${index}] must be an object`);
    }
    const key = requireNonEmptyString(value.key, `universities[${index}].key`);
    const fullName = requireNonEmptyString(
        value.fullName,
        `universities[${index}].fullName`,
    );
    const acronym = requireNonEmptyString(
        value.acronym,
        `universities[${index}].acronym`,
    );
    const queries =
        value.queries === undefined
            ? undefined
            : validateQueries(value.queries, index);
    return { key, fullName, acronym, ...(queries ? { queries } : {}) };
}

function validateQueries(
    value: unknown,
    universityIndex: number,
): SearchQueries {
    if (!isRecord(value)) {
        throw new TypeError(
            `universities[${universityIndex}].queries must be an object`,
        );
    }
    const queries: SearchQueries = {};
    for (const field of ['repositories', 'organizations', 'users'] as const) {
        const query = value[field];
        if (query !== undefined) {
            queries[field] = requireNonEmptyString(
                query,
                `universities[${universityIndex}].queries.${field}`,
            );
        }
    }
    return queries;
}

function readBoundedInteger(
    value: unknown,
    defaultValue: number,
    name: string,
    minimum: number,
    maximum: number,
): number {
    const result = value === undefined ? defaultValue : value;
    if (
        typeof result !== 'number' ||
        !Number.isInteger(result) ||
        result < minimum ||
        result > maximum
    ) {
        throw new TypeError(
            `${name} must be an integer from ${minimum} to ${maximum}`,
        );
    }
    return result;
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${name} must be a non-empty string`);
    }
    if (value.includes('\u0000')) {
        throw new TypeError(`${name} must not contain an actual NUL byte`);
    }
    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
