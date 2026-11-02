import { generateKeyPairSync, verify } from 'node:crypto';
import { GitHubAppTokenProvider } from '../utils/githubAppToken';

describe('GitHubAppTokenProvider', () => {
    test('reuses the initial token, then renews once for concurrent callers', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
        });
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        let refreshRequests = 0;
        const fetchImplementation: typeof fetch = async (input, init) => {
            refreshRequests += 1;
            expect(String(input)).toBe(
                'https://api.github.com/app/installations/12345/access_tokens',
            );
            expect(init?.method).toBe('POST');
            expect(JSON.parse(String(init?.body))).toEqual({
                permissions: { contents: 'read' },
            });
            const authorization = new Headers(init?.headers).get(
                'Authorization',
            );
            expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
            const jwt = authorization!.slice('Bearer '.length);
            const [encodedHeader, encodedPayload, encodedSignature] =
                jwt.split('.');
            expect(
                JSON.parse(
                    Buffer.from(encodedHeader!, 'base64url').toString('utf8'),
                ),
            ).toEqual({ alg: 'RS256', typ: 'JWT' });
            const payload = JSON.parse(
                Buffer.from(encodedPayload!, 'base64url').toString('utf8'),
            ) as { exp: number; iat: number; iss: string };
            expect(payload.iss).toBe('app-42');
            expect(payload.exp - payload.iat).toBe(9 * 60);
            expect(
                verify(
                    'RSA-SHA256',
                    Buffer.from(`${encodedHeader}.${encodedPayload}`),
                    publicKey,
                    Buffer.from(encodedSignature!, 'base64url'),
                ),
            ).toBe(true);
            return new Response(
                JSON.stringify({
                    token: 'renewed-installation-token',
                    expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
                }),
                { status: 201 },
            );
        };
        const provider = new GitHubAppTokenProvider({
            appId: 'app-42',
            privateKey: privateKey
                .export({ type: 'pkcs8', format: 'pem' })
                .toString(),
            installationId: '12345',
            initialToken: 'workflow-installation-token',
            fetch: fetchImplementation,
            now: () => now,
        });

        await expect(provider.getToken()).resolves.toBe(
            'workflow-installation-token',
        );
        now += 44 * 60 * 1_000;
        await expect(provider.getToken()).resolves.toBe(
            'workflow-installation-token',
        );
        expect(refreshRequests).toBe(0);

        now += 2 * 60 * 1_000;
        await expect(
            Promise.all([provider.getToken(), provider.getToken()]),
        ).resolves.toEqual([
            'renewed-installation-token',
            'renewed-installation-token',
        ]);
        expect(refreshRequests).toBe(1);

        await expect(provider.getToken()).resolves.toBe(
            'renewed-installation-token',
        );
        expect(refreshRequests).toBe(1);
    });

    test('rejects an incomplete App credential set without exposing secret values', () => {
        expect(
            () =>
                new GitHubAppTokenProvider({
                    appId: 'app-42',
                    privateKey: '',
                    installationId: '12345',
                }),
        ).toThrow('GitHub App private key must be set');
    });
});
