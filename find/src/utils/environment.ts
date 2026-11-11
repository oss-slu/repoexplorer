import { config as loadDotEnv } from 'dotenv';

export type GitHubCredentialSource = 'environment' | 'root-env-file' | 'none';

export type GitHubCredentialState = {
    source: GitHubCredentialSource;
    /** Whether a token variable is present. */
    configured: boolean;
    /** Whether the configured token has non-empty credential material. */
    usable: boolean;
};

export type GitHubTokenProvenance = GitHubCredentialState;

/** Load the root environment with the same no-overwrite precedence as collection. */
export function loadEnvironmentFile(
    rootEnvPath: string,
): GitHubTokenProvenance {
    const tokenWasInEnvironment = process.env.GITHUB_TOKEN !== undefined;
    const result = loadDotEnv({
        path: rootEnvPath,
        override: false,
        quiet: true,
    });
    const fileDefinesToken =
        result.parsed !== undefined &&
        Object.prototype.hasOwnProperty.call(result.parsed, 'GITHUB_TOKEN');
    const tokenWasLoadedFromFile =
        !tokenWasInEnvironment &&
        fileDefinesToken &&
        process.env.GITHUB_TOKEN !== undefined;
    const source = tokenWasInEnvironment
        ? 'environment'
        : tokenWasLoadedFromFile
          ? 'root-env-file'
          : 'none';
    return {
        source,
        configured: source !== 'none',
        usable: Boolean(process.env.GITHUB_TOKEN?.trim()),
    };
}

export function getCurrentTokenProvenance(): GitHubTokenProvenance {
    const configured = process.env.GITHUB_TOKEN !== undefined;
    return {
        source: configured ? 'environment' : 'none',
        configured,
        usable: Boolean(process.env.GITHUB_TOKEN?.trim()),
    };
}

/** Report which auth source normal collection would select without exposing it. */
export function getGitHubCredentialState(
    provenance: GitHubTokenProvenance,
): GitHubCredentialState {
    return {
        source: provenance.source,
        configured: provenance.configured,
        usable: provenance.usable,
    };
}
