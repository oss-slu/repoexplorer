import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
    EnrichmentApi,
    ScrapingConfiguration,
    ClassificationConfiguration,
    SearchQueries,
    UniversityConfiguration,
    TextTruncationConfiguration,
    ClassificationGenerationSettings,
    ReasoningEffort,
} from './types/scraping';
import { REASONING_EFFORTS } from './types/scraping';

const DEFAULT_REPOSITORY_CONCURRENCY = 4;
const DEFAULT_DATABASE_BATCH_SIZE = 100;
/** Reasoning models spend part of `max_completion_tokens` before writing the reply. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MAX_OUTPUT_TOKENS_LIMIT = 32_768;
const DEFAULT_CLASSIFICATION_CONFIGURATION: ClassificationConfiguration = {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    threshold: 0.4,
    concurrency: 4,
    timeoutMs: 60_000,
    maxRetries: 3,
    promptVersion: 'v3',
    citationMode: 'exact_quote',
    affiliationEvidenceGate: 'names_institution',
    generation: {
        responseFormat: 'text',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        maxOutputTokensField: 'max_completion_tokens',
    },
    truncation: {
        mode: 'start_end',
        maxChars: 20_000,
        startChars: 15_000,
        endChars: 5_000,
    },
};

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
        ...(value.enrichmentApi === undefined
            ? {}
            : { enrichmentApi: readEnrichmentApi(value.enrichmentApi) }),
        // No implicit provider: without a classification block, `classify`
        // refuses to run instead of sending repositories to a default model.
        ...(value.classification === undefined
            ? {}
            : {
                  classification: validateClassificationConfiguration(
                      value.classification,
                  ),
              }),
    };
}

function readEnrichmentApi(value: unknown): EnrichmentApi {
    if (value !== 'graphql' && value !== 'rest') {
        throw new TypeError("enrichmentApi must be 'graphql' or 'rest'");
    }
    return value;
}

export function validateClassificationConfiguration(
    value: unknown,
): ClassificationConfiguration {
    if (!isRecord(value)) {
        throw new TypeError('classification must be an object');
    }
    const provider = requireNonEmptyString(
        value.provider ?? DEFAULT_CLASSIFICATION_CONFIGURATION.provider,
        'classification.provider',
    );
    const baseUrl = requireNonEmptyString(
        value.baseUrl ?? DEFAULT_CLASSIFICATION_CONFIGURATION.baseUrl,
        'classification.baseUrl',
    );
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(baseUrl);
    } catch (error) {
        throw new TypeError('classification.baseUrl must be an HTTP(S) URL', {
            cause: error,
        });
    }
    if (
        !['http:', 'https:'].includes(parsedUrl.protocol) ||
        parsedUrl.username !== '' ||
        parsedUrl.password !== '' ||
        parsedUrl.search !== '' ||
        parsedUrl.hash !== ''
    ) {
        throw new TypeError(
            'classification.baseUrl must be an HTTP(S) URL without credentials, query, or fragment',
        );
    }
    const model = requireNonEmptyString(
        value.model ?? DEFAULT_CLASSIFICATION_CONFIGURATION.model,
        'classification.model',
    );
    const apiKeyEnv = requireNonEmptyString(
        value.apiKeyEnv ?? DEFAULT_CLASSIFICATION_CONFIGURATION.apiKeyEnv,
        'classification.apiKeyEnv',
    );
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        throw new TypeError(
            'classification.apiKeyEnv must be an environment variable name',
        );
    }
    const threshold =
        value.threshold ?? DEFAULT_CLASSIFICATION_CONFIGURATION.threshold;
    if (
        typeof threshold !== 'number' ||
        !Number.isFinite(threshold) ||
        threshold < 0 ||
        threshold > 1
    ) {
        throw new TypeError(
            'classification.threshold must be a finite number from 0 to 1',
        );
    }
    const truncation = validateTruncation(
        value.truncation ?? DEFAULT_CLASSIFICATION_CONFIGURATION.truncation,
    );
    const generation = validateGenerationSettings(
        value.generation ?? DEFAULT_CLASSIFICATION_CONFIGURATION.generation,
    );
    const affiliationEvidenceGate =
        value.affiliationEvidenceGate ??
        DEFAULT_CLASSIFICATION_CONFIGURATION.affiliationEvidenceGate;
    if (
        affiliationEvidenceGate !== 'names_institution' &&
        affiliationEvidenceGate !== 'off'
    ) {
        throw new TypeError(
            'classification.affiliationEvidenceGate must be names_institution or off',
        );
    }
    const citationMode = value.citationMode ?? 'exact_quote';
    if (citationMode !== 'exact_quote' && citationMode !== 'evidence_id') {
        throw new TypeError(
            'classification.citationMode must be exact_quote or evidence_id',
        );
    }
    if (
        truncation.mode === 'start_end' &&
        truncation.startChars + truncation.endChars > truncation.maxChars
    ) {
        throw new TypeError(
            'classification.truncation startChars + endChars must not exceed maxChars',
        );
    }
    return {
        provider,
        baseUrl: parsedUrl.toString().replace(/\/$/, ''),
        model,
        apiKeyEnv,
        threshold,
        concurrency: readBoundedInteger(
            value.concurrency,
            DEFAULT_CLASSIFICATION_CONFIGURATION.concurrency,
            'classification.concurrency',
            1,
            16,
        ),
        timeoutMs: readBoundedInteger(
            value.timeoutMs,
            DEFAULT_CLASSIFICATION_CONFIGURATION.timeoutMs,
            'classification.timeoutMs',
            100,
            300_000,
        ),
        maxRetries: readBoundedInteger(
            value.maxRetries,
            DEFAULT_CLASSIFICATION_CONFIGURATION.maxRetries,
            'classification.maxRetries',
            0,
            8,
        ),
        promptVersion: readPromptVersion(value.promptVersion),
        citationMode,
        affiliationEvidenceGate,
        truncation,
        generation,
    };
}

/** v2 is kept to reproduce the earlier baseline; v3 adds the score rubric. */
const PROMPT_VERSIONS = ['v2', 'v3'] as const;

function readPromptVersion(value: unknown): string {
    const version = value ?? DEFAULT_CLASSIFICATION_CONFIGURATION.promptVersion;
    if (
        !PROMPT_VERSIONS.includes(version as (typeof PROMPT_VERSIONS)[number])
    ) {
        throw new TypeError(
            `classification.promptVersion must be one of ${PROMPT_VERSIONS.join(', ')}`,
        );
    }
    return version as string;
}

function validateGenerationSettings(
    value: unknown,
): ClassificationGenerationSettings {
    if (!isRecord(value)) {
        throw new TypeError('classification.generation must be an object');
    }
    const responseFormat = value.responseFormat ?? 'text';
    if (
        responseFormat !== 'json_schema' &&
        responseFormat !== 'json_object' &&
        responseFormat !== 'text'
    ) {
        throw new TypeError(
            'classification.generation.responseFormat must be json_schema, json_object, or text',
        );
    }
    const temperature = value.temperature;
    if (
        temperature !== undefined &&
        (typeof temperature !== 'number' ||
            !Number.isFinite(temperature) ||
            temperature < 0 ||
            temperature > 2)
    ) {
        throw new TypeError(
            'classification.generation.temperature must be a finite number from 0 to 2',
        );
    }
    const maxOutputTokens = readBoundedInteger(
        value.maxOutputTokens,
        DEFAULT_MAX_OUTPUT_TOKENS,
        'classification.generation.maxOutputTokens',
        1,
        MAX_OUTPUT_TOKENS_LIMIT,
    );
    const reasoningEffort = value.reasoningEffort;
    if (
        reasoningEffort !== undefined &&
        !REASONING_EFFORTS.includes(reasoningEffort as ReasoningEffort)
    ) {
        throw new TypeError(
            `classification.generation.reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}`,
        );
    }
    const maxOutputTokensField =
        value.maxOutputTokensField ?? 'max_completion_tokens';
    if (
        maxOutputTokensField !== 'max_tokens' &&
        maxOutputTokensField !== 'max_completion_tokens'
    ) {
        throw new TypeError(
            'classification.generation.maxOutputTokensField must be max_tokens or max_completion_tokens',
        );
    }
    const seed = value.seed;
    if (
        seed !== undefined &&
        (typeof seed !== 'number' ||
            !Number.isSafeInteger(seed) ||
            seed < 0 ||
            seed > 2_147_483_647)
    ) {
        throw new TypeError(
            'classification.generation.seed must be a safe integer from 0 to 2147483647',
        );
    }
    return {
        responseFormat,
        ...(temperature === undefined
            ? {}
            : { temperature: temperature as number }),
        maxOutputTokens,
        maxOutputTokensField,
        ...(reasoningEffort === undefined
            ? {}
            : { reasoningEffort: reasoningEffort as ReasoningEffort }),
        ...(seed === undefined ? {} : { seed: seed as number }),
    };
}

function validateTruncation(value: unknown): TextTruncationConfiguration {
    if (!isRecord(value)) {
        throw new TypeError('classification.truncation must be an object');
    }
    const mode = value.mode ?? 'start_end';
    if (mode !== 'start' && mode !== 'start_end') {
        throw new TypeError(
            'classification.truncation.mode must be start or start_end',
        );
    }
    return {
        mode,
        maxChars: readBoundedInteger(
            value.maxChars,
            20_000,
            'classification.truncation.maxChars',
            1,
            200_000,
        ),
        startChars: readBoundedInteger(
            value.startChars,
            15_000,
            'classification.truncation.startChars',
            0,
            200_000,
        ),
        endChars: readBoundedInteger(
            value.endChars,
            5_000,
            'classification.truncation.endChars',
            0,
            200_000,
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
    const emailDomains =
        value.emailDomains === undefined
            ? undefined
            : readStringArray(
                  value.emailDomains,
                  `universities[${index}].emailDomains`,
              );
    const additionalQueries =
        value.additionalQueries === undefined
            ? undefined
            : readStringArray(
                  value.additionalQueries,
                  `universities[${index}].additionalQueries`,
              );
    const affiliationDefinition =
        value.affiliationDefinition === undefined
            ? undefined
            : requireNonEmptyString(
                  value.affiliationDefinition,
                  `universities[${index}].affiliationDefinition`,
              );
    const alternateNames =
        value.alternateNames === undefined
            ? undefined
            : readStringArray(
                  value.alternateNames,
                  `universities[${index}].alternateNames`,
              );
    const excludedNames =
        value.excludedNames === undefined
            ? undefined
            : readStringArray(
                  value.excludedNames,
                  `universities[${index}].excludedNames`,
              );
    const queries =
        value.queries === undefined
            ? undefined
            : validateQueries(value.queries, index);
    return {
        key,
        fullName,
        acronym,
        ...(emailDomains ? { emailDomains } : {}),
        ...(additionalQueries ? { additionalQueries } : {}),
        ...(affiliationDefinition ? { affiliationDefinition } : {}),
        ...(alternateNames ? { alternateNames } : {}),
        ...(excludedNames ? { excludedNames } : {}),
        ...(queries ? { queries } : {}),
    };
}

function readStringArray(value: unknown, name: string): string[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array of strings`);
    }
    return value.map((item, index) =>
        requireNonEmptyString(item, `${name}[${index}]`),
    );
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
