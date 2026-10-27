import { validateScrapingConfiguration } from '../config';
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
        });
        expect(parseCliOptions(['--verbose']).verbose).toBe(true);
        expect(parseCliOptions([]).policy).toBe('best-effort');
        expect(parseCliOptions(['--strict']).policy).toBe('strict');
    });

    test('rejects actual NUL in university keys and search strings', () => {
        expect(() =>
            validateScrapingConfiguration({
                universities: [
                    { key: 'University\u0000', fullName: 'University', acronym: 'U' },
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
});
