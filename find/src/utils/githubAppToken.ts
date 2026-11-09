import { sign } from 'node:crypto';

const DEFAULT_TOKEN_LIFETIME_MS = 50 * 60 * 1_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1_000;
const APP_JWT_LIFETIME_SECONDS = 9 * 60;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export type GitHubAppTokenProviderConfig = {
    appId: string;
    privateKey: string;
    installationId: string;
    initialToken?: string;
    initialTokenLifetimeMs?: number;
    apiUrl?: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
};

/** Renews installation tokens before their one-hour expiry. */
export class GitHubAppTokenProvider {
    private readonly now: () => number;
    private readonly fetchImplementation: typeof globalThis.fetch;
    private readonly apiUrl: string;
    private token?: string;
    private refreshAt: number;
    private pendingRefresh?: Promise<string>;

    constructor(private readonly config: GitHubAppTokenProviderConfig) {
        requireValue(config.appId, 'GitHub App ID');
        requireValue(config.privateKey, 'GitHub App private key');
        requireValue(config.installationId, 'GitHub App installation ID');
        this.now = config.now ?? Date.now;
        this.fetchImplementation = config.fetch ?? globalThis.fetch;
        this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(
            /\/$/,
            '',
        );
        if (!/^https:\/\//i.test(this.apiUrl)) {
            throw new TypeError('GitHub API URL must use HTTPS');
        }
        if (config.initialToken) {
            this.token = config.initialToken;
            const lifetime =
                config.initialTokenLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;
            if (!Number.isInteger(lifetime) || lifetime <= 0) {
                throw new RangeError(
                    'Initial GitHub App token lifetime must be a positive integer',
                );
            }
            this.refreshAt =
                this.now() + Math.max(1, lifetime - TOKEN_REFRESH_BUFFER_MS);
        } else {
            this.refreshAt = 0;
        }
    }

    async getToken(signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) throw signal.reason;
        if (this.token && this.now() < this.refreshAt) return this.token;
        this.pendingRefresh ??= this.refreshToken(signal).finally(() => {
            this.pendingRefresh = undefined;
        });
        return this.pendingRefresh;
    }

    private async refreshToken(signal?: AbortSignal): Promise<string> {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(new Error('GitHub App token request timed out')),
            TOKEN_REQUEST_TIMEOUT_MS,
        );
        const abortRefresh = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abortRefresh, { once: true });
        try {
            if (signal?.aborted) abortRefresh();
            const response = await this.fetchImplementation(
                `${this.apiUrl}/app/installations/${encodeURIComponent(this.config.installationId)}/access_tokens`,
                {
                    method: 'POST',
                    headers: {
                        Accept: 'application/vnd.github+json',
                        Authorization: `Bearer ${createAppJwt(this.config.appId, this.config.privateKey, this.now())}`,
                        'Content-Type': 'application/json',
                        'X-GitHub-Api-Version': '2022-11-28',
                    },
                    body: JSON.stringify({ permissions: { contents: 'read' } }),
                    signal: controller.signal,
                },
            );
            if (!response.ok) {
                throw new Error(
                    `Could not refresh the GitHub App installation token (HTTP ${response.status})`,
                );
            }
            let payload: unknown;
            try {
                payload = await response.json();
            } catch {
                throw new Error('GitHub returned an invalid App token response');
            }
            if (
                payload === null ||
                typeof payload !== 'object' ||
                !('token' in payload) ||
                typeof payload.token !== 'string' ||
                payload.token.trim() === '' ||
                !('expires_at' in payload) ||
                typeof payload.expires_at !== 'string'
            ) {
                throw new Error('GitHub returned an invalid App token response');
            }
            const expiresAt = Date.parse(payload.expires_at);
            if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
                throw new Error('GitHub returned an expired App token');
            }
            this.token = payload.token;
            this.refreshAt = Math.max(
                this.now(),
                expiresAt - TOKEN_REFRESH_BUFFER_MS,
            );
            return this.token;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abortRefresh);
        }
    }
}

function createAppJwt(appId: string, privateKey: string, now: number): string {
    const issuedAt = Math.floor(now / 1_000) - 60;
    const payload = {
        iat: issuedAt,
        exp: issuedAt + APP_JWT_LIFETIME_SECONDS,
        iss: appId,
    };
    const encodedHeader = encodeBase64Url(
        JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
    );
    const encodedPayload = encodeBase64Url(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;
    const key = privateKey.replaceAll('\\n', '\n');
    const signature = sign(
        'RSA-SHA256',
        Buffer.from(unsignedToken),
        key,
    ).toString('base64url');
    return `${unsignedToken}.${signature}`;
}

function encodeBase64Url(value: string): string {
    return Buffer.from(value).toString('base64url');
}

function requireValue(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${name} must be set`);
    }
}
