import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    getGitHubCredentialState,
    loadEnvironmentFile,
} from '../utils/environment';

const variableNames = [
    'GITHUB_TOKEN',
    'FINDER_GITHUB_APP_ID',
    'FINDER_GITHUB_APP_PRIVATE_KEY',
    'FINDER_GITHUB_APP_INSTALLATION_ID',
] as const;
const originalEnvironment = new Map(
    variableNames.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
    for (const name of variableNames) delete process.env[name];
});

afterAll(() => {
    for (const name of variableNames) {
        const value = originalEnvironment.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

async function withEnvFile(
    content: string,
    callback: (envFilePath: string) => Promise<void> | void,
): Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), 'finder-env-'));
    const envFilePath = path.join(directory, '.env');
    try {
        await writeFile(envFilePath, content);
        await callback(envFilePath);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('uses the shell token before the root dotenv token', async () => {
    process.env.GITHUB_TOKEN = 'shell-secret-sentinel';
    await withEnvFile('GITHUB_TOKEN=root-secret-sentinel\n', (envFilePath) => {
        const provenance = loadEnvironmentFile(envFilePath);
        expect(provenance).toEqual({
            source: 'environment',
            configured: true,
            usable: true,
        });
        expect(process.env.GITHUB_TOKEN).toBe('shell-secret-sentinel');
    });
});

test('uses the root dotenv token when the shell variable is absent', async () => {
    await withEnvFile('GITHUB_TOKEN=root-secret-sentinel\n', (envFilePath) => {
        const provenance = loadEnvironmentFile(envFilePath);
        expect(provenance).toEqual({
            source: 'root-env-file',
            configured: true,
            usable: true,
        });
        expect(process.env.GITHUB_TOKEN).toBe('root-secret-sentinel');
    });
});

test('does not replace an empty exported token with the root dotenv token', async () => {
    process.env.GITHUB_TOKEN = '';
    await withEnvFile('GITHUB_TOKEN=root-secret-sentinel\n', (envFilePath) => {
        const provenance = loadEnvironmentFile(envFilePath);
        expect(provenance).toEqual({
            source: 'environment',
            configured: true,
            usable: false,
        });
        expect(process.env.GITHUB_TOKEN).toBe('');
        expect(getGitHubCredentialState(provenance)).toEqual({
            source: 'environment',
            configured: true,
            usable: false,
        });
    });
});

test('reports no credential when neither source defines a token', async () => {
    await withEnvFile('OTHER_VALUE=present\n', (envFilePath) => {
        const provenance = loadEnvironmentFile(envFilePath);
        expect(provenance).toEqual({
            source: 'none',
            configured: false,
            usable: false,
        });
    });
});

test('reports the active GitHub App provider without exposing its settings', () => {
    process.env.FINDER_GITHUB_APP_ID = 'app-id-secret';
    process.env.FINDER_GITHUB_APP_PRIVATE_KEY = 'private-key-secret';
    process.env.FINDER_GITHUB_APP_INSTALLATION_ID = 'installation-secret';
    const state = getGitHubCredentialState({
        source: 'none',
        configured: false,
        usable: false,
    });
    expect(state).toEqual({
        source: 'github-app',
        configured: true,
        usable: true,
    });
    expect(JSON.stringify(state)).not.toContain('secret');
});
