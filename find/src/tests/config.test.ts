import { validateScrapingConfiguration } from '../config';
import { parseCliArguments, runCli } from '../cli';
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
