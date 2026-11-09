import { config as loadDotEnv } from 'dotenv';

export type GitHubCredentialSource =
    | 'environment'
    | 'root-env-file'
    | 'github-app'
    | 'none';

export type GitHubCredentialState = {
    source: GitHubCredentialSource;
    /** Provider used to refresh an initial token from the environment or dotenv. */
    refreshProvider?: 'github-app';
    /** Whether a token variable or complete provider configuration is present. */
    configured: boolean;
    /** Whether the configured token/provider has non-empty credential material. */
    usable: boolean;
};

export type GitHubTokenProvenance = {
    source: Exclude<GitHubCredentialSource, 'github-app'>;
    configured: boolean;
    usable: boolean;
};

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
    const appId = process.env.FINDER_GITHUB_APP_ID?.trim();
    const privateKey = process.env.FINDER_GITHUB_APP_PRIVATE_KEY?.trim();
    const installationId =
        process.env.FINDER_GITHUB_APP_INSTALLATION_ID?.trim();
    const hasAnyAppSetting = Boolean(appId || privateKey || installationId);
    if (hasAnyAppSetting) {
        const appConfigured = Boolean(appId && privateKey && installationId);
        return {
            source: appConfigured && provenance.usable ? provenance.source : 'github-app',
            ...(appConfigured && provenance.usable
                ? { refreshProvider: 'github-app' as const }
                : {}),
            configured: true,
            usable: appConfigured,
        };
    }
    return {
        source: provenance.source,
        configured: provenance.configured,
        usable: provenance.usable,
    };
}
