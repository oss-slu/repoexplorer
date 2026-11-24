import { readFile } from 'node:fs/promises';
import {
    loadScrapingConfiguration,
    validateClassificationConfiguration,
    validateScrapingConfiguration,
} from '../config';
import { parseCliArguments, parseCliOptions, runCli } from '../cli';
import { getDatabasePoolConfig } from '../db/connect';

describe('scraping configuration', () => {
    test('applies bounded defaults and keeps explicit queries', () => {
        expect(
            validateScrapingConfiguration({
                universities: [
                    {
                        key: 'Saint Louis University',
                        fullName: 'Saint Louis University',
                        acronym: 'SLU',
                        queries: { repositories: 'org:slu' },
                    },
                ],
            }),
        ).toMatchObject({
            universities: [{ queries: { repositories: 'org:slu' } }],
            repositoryConcurrency: 4,
            databaseBatchSize: 100,
        });
    });

    test('accepts an explicit enrichment API and rejects unknown values', () => {
        const universities = [
            { key: 'SLU', fullName: 'Saint Louis University', acronym: 'SLU' },
        ];
        expect(
            validateScrapingConfiguration({ universities }).enrichmentApi,
        ).toBeUndefined();
        expect(
            validateScrapingConfiguration({
                universities,
                enrichmentApi: 'rest',
            }).enrichmentApi,
        ).toBe('rest');
        expect(() =>
            validateScrapingConfiguration({
                universities,
                enrichmentApi: 'soap',
            }),
        ).toThrow(/enrichmentApi/);
    });

    test('rejects missing, duplicate, and malformed university entries', () => {
        expect(() =>
            validateScrapingConfiguration({ universities: [] }),
        ).toThrow(/at least one university/);
        expect(() =>
            validateScrapingConfiguration({
                universities: [
                    { key: 'A', fullName: 'Alpha', acronym: 'A' },
                    { key: 'a', fullName: 'Another', acronym: 'A2' },
                ],
            }),
        ).toThrow(/duplicated/);
        expect(() =>
            validateScrapingConfiguration({
                universities: [{ key: 'A', fullName: '', acronym: 'A' }],
            }),
        ).toThrow(/fullName/);
    });

    test('rejects unsafe worker settings and invalid CLI arguments', () => {
        expect(() =>
            validateScrapingConfiguration({
                universities: [{ key: 'A', fullName: 'Alpha', acronym: 'A' }],
                repositoryConcurrency: 0,
            }),
        ).toThrow(/repositoryConcurrency/);
        expect(() => parseCliArguments(['--config'])).toThrow(
            /requires a file path/,
        );
        expect(() => parseCliArguments(['--surprise'])).toThrow(
            /Unknown argument/,
        );
        expect(parseCliArguments(['--config', 'sample.json'])).toBe(
            'sample.json',
        );
        expect(parseCliOptions(['-v', '--config', 'sample.json'])).toEqual({
            configPath: 'sample.json',
            verbose: true,
            policy: 'best-effort',
            mode: 'full',
        });
        expect(parseCliOptions(['--verbose']).verbose).toBe(true);
        expect(parseCliOptions([]).policy).toBe('best-effort');
        expect(parseCliOptions(['--strict']).policy).toBe('strict');
        expect(parseCliOptions(['--mode', 'refresh'])).toMatchObject({
            mode: 'refresh',
        });
        expect(
            parseCliOptions([
                '--mode',
                'full',
                '--university',
                'Saint Louis University',
                '--run-id',
                'manual-123',
            ]),
        ).toMatchObject({
            mode: 'full',
            university: 'Saint Louis University',
            runId: 'manual-123',
        });
        expect(() => parseCliOptions(['--mode', 'unknown'])).toThrow(
            /either full or refresh/,
        );
    });

    test('rejects actual NUL in university keys and search strings', () => {
        expect(() =>
            validateScrapingConfiguration({
                universities: [
                    {
                        key: 'University\u0000',
                        fullName: 'University',
                        acronym: 'U',
                    },
                ],
            }),
        ).toThrow(/key must not contain an actual NUL/);
        expect(() =>
            validateScrapingConfiguration({
                universities: [
                    {
                        key: 'University',
                        fullName: 'University',
                        acronym: 'U',
                        queries: { repositories: 'text\u0000query' },
                    },
                ],
            }),
        ).toThrow(/repositories must not contain an actual NUL/);
    });

    test('validates classifier provider, threshold, retries, and truncation settings', () => {
        expect(
            validateScrapingConfiguration({
                universities: [
                    {
                        key: 'A',
                        fullName: 'Alpha University',
                        acronym: 'AU',
                        emailDomains: ['alpha.edu'],
                        additionalQueries: ['Alpha'],
                    },
                ],
            }),
        ).toMatchObject({
            universities: [
                { emailDomains: ['alpha.edu'], additionalQueries: ['Alpha'] },
            ],
            classification: {
                threshold: 0.4,
                model: 'gpt-5-mini',
                promptVersion: 'v3',
                generation: {
                    responseFormat: 'text',
                    maxOutputTokens: 8192,
                    maxOutputTokensField: 'max_completion_tokens',
                },
            },
        });
        expect(() =>
            validateClassificationConfiguration({ threshold: 1.1 }),
        ).toThrow(/threshold/);
        expect(() =>
            validateClassificationConfiguration({ apiKeyEnv: 'bad-name' }),
        ).toThrow(/environment variable/);
        expect(() =>
            validateClassificationConfiguration({
                truncation: {
                    mode: 'start_end',
                    maxChars: 10,
                    startChars: 9,
                    endChars: 2,
                },
            }),
        ).toThrow(/must not exceed/);
    });

    test('validates bounded classification generation settings and safe seeds', () => {
        expect(
            validateClassificationConfiguration({
                generation: {
                    responseFormat: 'json_schema',
                    temperature: 2,
                    maxOutputTokens: 32768,
                    maxOutputTokensField: 'max_completion_tokens',
                    reasoningEffort: 'low',
                    seed: 2147483647,
                },
            }).generation,
        ).toEqual({
            responseFormat: 'json_schema',
            temperature: 2,
            maxOutputTokens: 32768,
            maxOutputTokensField: 'max_completion_tokens',
            reasoningEffort: 'low',
            seed: 2147483647,
        });
        const omitted = validateClassificationConfiguration({
            generation: { responseFormat: 'text' },
        }).generation;
        expect(omitted).not.toHaveProperty('temperature');
        expect(omitted).not.toHaveProperty('reasoningEffort');
        expect(omitted.maxOutputTokens).toBe(8192);
        for (const reasoningEffort of ['extreme', '', 1]) {
            expect(() =>
                validateClassificationConfiguration({
                    generation: { reasoningEffort },
                }),
            ).toThrow(/reasoningEffort/);
        }
        for (const temperature of [-0.01, 2.01, Number.NaN]) {
            expect(() =>
                validateClassificationConfiguration({
                    generation: { temperature },
                }),
            ).toThrow(/temperature/);
        }
        for (const maxOutputTokens of [0, 32769, 1.5]) {
            expect(() =>
                validateClassificationConfiguration({
                    generation: { maxOutputTokens },
                }),
            ).toThrow(/maxOutputTokens/);
        }
        for (const seed of [-1, 2147483648, 1.5, Number.NaN]) {
            expect(() =>
                validateClassificationConfiguration({
                    generation: { seed },
                }),
            ).toThrow(/seed/);
        }
        expect(() =>
            validateClassificationConfiguration({
                generation: { responseFormat: 'xml' },
            }),
        ).toThrow(/responseFormat/);
    });

    test('defaults to exact citations and validates the evidence reference wire mode', () => {
        expect(validateClassificationConfiguration({}).citationMode).toBe(
            'exact_quote',
        );
        expect(
            validateClassificationConfiguration({
                citationMode: 'evidence_id',
            }).citationMode,
        ).toBe('evidence_id');
        expect(() =>
            validateClassificationConfiguration({ citationMode: 'fuzzy' }),
        ).toThrow(/citationMode/);
    });

    test('uses the documented host defaults and rejects invalid configuration before database setup', async () => {
        expect(
            getDatabasePoolConfig({
                PGDATABASE: 'repoexplorer',
                PGUSER: 'repoexplorer_app',
                PGPASSWORD: 'private-test-value',
            }),
        ).toMatchObject({ host: '127.0.0.1', port: 5433 });
        await expect(runCli(['--config', 'package.json'])).rejects.toThrow(
            /universities array/,
        );
    });

    test('example configurations keep temperature only where the provider accepts it', async () => {
        const openai = await loadScrapingConfiguration(
            'config/universities.openai.example.json',
        );
        expect(openai.classification?.model).toBe('gpt-5-mini');
        expect(openai.classification?.generation).not.toHaveProperty(
            'temperature',
        );
        expect(
            openai.classification?.generation.maxOutputTokens,
        ).toBeGreaterThanOrEqual(4096);
        const ollama = validateClassificationConfiguration(
            JSON.parse(
                await readFile('config/evaluation.example.json', 'utf8'),
            ) as unknown,
        );
        expect(ollama.generation).toMatchObject({
            temperature: 0,
            maxOutputTokensField: 'max_tokens',
        });
    });

    test('local example configurations use the recommended Granite setup', async () => {
        const universities = await loadScrapingConfiguration(
            'config/universities.example.json',
        );
        const evaluation = validateClassificationConfiguration(
            JSON.parse(
                await readFile('config/evaluation.example.json', 'utf8'),
            ) as unknown,
        );
        expect(universities.classification).toEqual(evaluation);
        expect(evaluation).toMatchObject({
            provider: 'ollama-openai-compatible',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'granite4.2-8b-12k',
            concurrency: 1,
            citationMode: 'evidence_id',
            affiliationEvidenceGate: 'names_institution',
            generation: {
                responseFormat: 'json_schema',
                reasoningEffort: 'none',
            },
        });
        const modelfile = await readFile(
            'config/ollama/granite4.2-8b-12k.Modelfile',
            'utf8',
        );
        expect(modelfile).toMatch(/^FROM granite4\.2:8b$/m);
        expect(modelfile).toMatch(/^PARAMETER num_ctx 12288$/m);
    });

    test('universities example and OpenAI variant differ only in classification', async () => {
        const local = JSON.parse(
            await readFile('config/universities.example.json', 'utf8'),
        ) as Record<string, unknown>;
        const openai = JSON.parse(
            await readFile('config/universities.openai.example.json', 'utf8'),
        ) as Record<string, unknown>;
        expect({ ...local, classification: null }).toEqual({
            ...openai,
            classification: null,
        });
    });
});
