import { projectScrapingDiagnostic } from './scrapingDiagnostics';
import { GitHubRequestClient } from './githubRequest';
import type { GitHubCredentialState } from './environment';

export type GitHubAccessDiagnostic = {
    schemaVersion: 1;
    command: 'diagnose-github';
    outcome: 'success' | 'failure' | 'interrupted';
    credential: GitHubCredentialState;
    owner?: string;
    endpoint?: string;
    pageSize?: 1;
    status?: number;
    requestId?: string;
    reason: string;
    ssoStatus?: 'required' | 'partial-results';
    quota?: {
        bucket: 'core' | 'search';
        classification?: 'primary rate limit' | 'secondary rate limit';
        limit?: number;
        remaining?: number;
        resetAt?: number;
        retryAfterMs?: number;
    };
    nextStep: string;
};

export type GitHubAccessDiagnosticResult = {
    diagnostic: GitHubAccessDiagnostic;
    exitCode: 0 | 1;
};

const ORGANIZATION_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function isValidOrganizationLogin(owner: string): boolean {
    return owner.length <= 39 && ORGANIZATION_LOGIN.test(owner);
}

/** Probe one page of the organization repository endpoint using the shared client. */
export async function diagnoseGitHubAccess(
    client: GitHubRequestClient,
    owner: string,
    credential: GitHubCredentialState,
    signal?: AbortSignal,
): Promise<GitHubAccessDiagnosticResult> {
    if (!isValidOrganizationLogin(owner)) {
        return {
            diagnostic: {
                ...baseDiagnostic(credential),
                outcome: 'failure',
                owner: safeOwner(owner),
                reason: 'invalid-owner',
                nextStep: 'Pass a GitHub organization login using --owner; URLs and arbitrary paths are not accepted.',
            },
            exitCode: 1,
        };
    }

    const endpoint = `/orgs/${owner}/repos`;
    try {
        const response = await client.request<unknown>(endpoint, {
            query: { per_page: 1 },
            signal,
        });
        if (!Array.isArray(response.data)) {
            return {
                diagnostic: {
                    ...baseDiagnostic(credential),
                    outcome: 'failure',
                    owner,
                    endpoint,
                    pageSize: 1,
                    status: response.status,
                    requestId: safeRequestId(
                        response.headers.get('x-github-request-id'),
                    ),
                    reason: 'invalid-response',
                    nextStep: 'GitHub returned an unexpected response shape; retry the diagnostic later.',
                },
                exitCode: 1,
            };
        }
        return {
            diagnostic: {
                ...baseDiagnostic(credential),
                outcome: 'success',
                owner,
                endpoint,
                pageSize: 1,
                status: response.status,
                requestId: safeRequestId(
                    response.headers.get('x-github-request-id'),
                ),
                reason: 'access-confirmed',
                quota: quotaFromHeaders(response.headers),
                nextStep: 'This confirms access to one page at this moment; it does not establish search visibility or full-scrape success.',
            },
            exitCode: 0,
        };
    } catch (error) {
        if (signal?.aborted) throw error;
        const projected = projectScrapingDiagnostic(error);
        const rateLimit = projected.rateLimit;
        const observation = projected.rateLimitObservation;
        const quota = rateLimit
            ? {
                  bucket: rateLimit.bucket,
                  classification: rateLimit.classification,
                  ...(rateLimit.limit === undefined
                      ? {}
                      : { limit: rateLimit.limit }),
                  ...(rateLimit.remaining === undefined
                      ? {}
                      : { remaining: rateLimit.remaining }),
                  ...(rateLimit.resetAt === undefined
                      ? {}
                      : { resetAt: rateLimit.resetAt }),
                  ...(rateLimit.retryAfterMs === undefined
                      ? {}
                      : { retryAfterMs: rateLimit.retryAfterMs }),
              }
            : observation
              ? {
                    bucket: observation.bucket,
                    ...(observation.limit === undefined
                        ? {}
                        : { limit: observation.limit }),
                    ...(observation.remaining === undefined
                        ? {}
                        : { remaining: observation.remaining }),
                    ...(observation.resetAt === undefined
                        ? {}
                        : { resetAt: observation.resetAt }),
                    ...(observation.retryAfterMs === undefined
                        ? {}
                        : { retryAfterMs: observation.retryAfterMs }),
                }
              : undefined;
        const reason = diagnosticReason(projected);
        return {
            diagnostic: {
                ...baseDiagnostic(credential),
                outcome: 'failure',
                owner,
                endpoint,
                pageSize: 1,
                ...(projected.status === undefined
                    ? {}
                    : { status: projected.status }),
                ...(projected.requestId === undefined
                    ? {}
                    : { requestId: projected.requestId }),
                reason,
                ...(projected.ssoStatus
                    ? { ssoStatus: projected.ssoStatus }
                    : {}),
                ...(quota ? { quota } : {}),
                nextStep: diagnosticHint(projected),
            },
            exitCode: 1,
        };
    }
}

export function createInterruptedGitHubDiagnostic(
    credential: GitHubCredentialState,
    owner?: string,
    exitCode: 130 | 143 = 130,
): { diagnostic: GitHubAccessDiagnostic; exitCode: 130 | 143 } {
    return {
        diagnostic: {
            ...baseDiagnostic(credential),
            outcome: 'interrupted',
            ...(owner && isValidOrganizationLogin(owner) ? { owner } : {}),
            ...(owner && isValidOrganizationLogin(owner)
                ? { endpoint: `/orgs/${owner}/repos`, pageSize: 1 as const }
                : {}),
            reason: 'interrupted',
            nextStep: 'No access result is available because the diagnostic was interrupted.',
        },
        exitCode,
    };
}

export function createConfigurationGitHubDiagnostic(
    credential: GitHubCredentialState,
    reason: 'invalid-arguments' | 'invalid-credential-configuration',
    nextStep: string,
    owner?: string,
): GitHubAccessDiagnosticResult {
    return {
        diagnostic: {
            ...baseDiagnostic(credential),
            outcome: 'failure',
            ...(owner && isValidOrganizationLogin(owner) ? { owner } : {}),
            ...(owner && isValidOrganizationLogin(owner)
                ? { endpoint: `/orgs/${owner}/repos`, pageSize: 1 as const }
                : {}),
            reason,
            nextStep,
        },
        exitCode: 1,
    };
}

function baseDiagnostic(credential: GitHubCredentialState) {
    return {
        schemaVersion: 1 as const,
        command: 'diagnose-github' as const,
        credential,
    };
}

function safeOwner(value: string): string | undefined {
    return value.length <= 39 && /^[A-Za-z0-9-]+$/.test(value)
        ? value
        : undefined;
}

function safeRequestId(value: string | null): string | undefined {
    return value !== null && /^[A-Za-z0-9:-]{1,128}$/.test(value)
        ? value
        : undefined;
}

function quotaFromHeaders(headers: Headers): GitHubAccessDiagnostic['quota'] {
    const integer = (name: string): number | undefined => {
        const value = headers.get(name);
        if (value === null || !/^\d+$/.test(value.trim())) return undefined;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    };
    const bucket = headers.get('x-ratelimit-resource')?.toLowerCase();
    return {
        bucket: bucket === 'search' ? 'search' : 'core',
        ...(integer('x-ratelimit-limit') === undefined
            ? {}
            : { limit: integer('x-ratelimit-limit') }),
        ...(integer('x-ratelimit-remaining') === undefined
            ? {}
            : { remaining: integer('x-ratelimit-remaining') }),
        ...(integer('x-ratelimit-reset') === undefined
            ? {}
            : { resetAt: integer('x-ratelimit-reset') }),
    };
}

function diagnosticReason(
    diagnostic: ReturnType<typeof projectScrapingDiagnostic>,
): string {
    if (diagnostic.rateLimit) {
        return diagnostic.rateLimit.classification === 'primary rate limit'
            ? 'primary-rate-limit'
            : 'secondary-rate-limit';
    }
    if (diagnostic.accessReason) return diagnostic.accessReason;
    switch (diagnostic.category) {
        case 'credential-provider':
            return 'credential-provider';
        case 'authentication':
            return 'authentication';
        case 'permission':
            return 'unknown-forbidden';
        case 'not found':
            return 'not-found';
        case 'legal-restriction':
            return 'legal-restriction';
        case 'network':
            return 'network-error';
        case 'timeout':
            return 'timeout';
        case 'invalid-json':
            return 'invalid-response';
        default:
            return 'request-failed';
    }
}

function diagnosticHint(
    diagnostic: ReturnType<typeof projectScrapingDiagnostic>,
): string {
    if (diagnostic.category === 'credential-provider') {
        return 'Check the GitHub App private key, App and installation IDs, and installation-token authorization; the organization request was not sent.';
    }
    if (diagnostic.category === 'legal-restriction') {
        return diagnostic.remediationHint ?? 'GitHub reports that this resource is unavailable for legal reasons; the response does not establish the specific legal basis.';
    }
    if (diagnostic.accessReason === 'sso-required') {
        return 'Authorize the effective token for the organization’s SAML SSO requirement, if applicable.';
    }
    if (diagnostic.accessReason === 'token-resource-inaccessible') {
        return 'Check the effective personal access token’s access to this resource and endpoint.';
    }
    if (diagnostic.accessReason === 'integration-resource-inaccessible') {
        return 'Check the GitHub App installation includes this resource and can access the endpoint.';
    }
    if (diagnostic.accessReason === 'unknown-forbidden') {
        return 'Verify the effective token and organization access with this diagnostic; the exact cause is unconfirmed.';
    }
    if (diagnostic.rateLimit) {
        return 'The diagnostic did not wait or retry; retry after the reported quota reset or Retry-After interval.';
    }
    if (diagnostic.category === 'authentication') {
        return 'Check the credential selected by the finder. gh auth status may describe a different credential.';
    }
    if (diagnostic.category === 'not found') {
        return 'Confirm the organization login and whether the effective credential can access it.';
    }
    if (diagnostic.category === 'network' || diagnostic.category === 'timeout') {
        return 'Check network reachability and retry the bounded diagnostic later.';
    }
    return 'Review the diagnostic reason and retry only after correcting the reported configuration or access issue.';
}
