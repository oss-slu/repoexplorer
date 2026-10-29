import {
    formatScrapingDiagnostic,
    projectScrapingDiagnostic,
    sanitizeGitHubEndpoint,
} from './scrapingDiagnostics';

export { sanitizeGitHubEndpoint };

/** Formats the shared safe diagnostic projection for terminal output. */
export function formatScrapingError(error: Error): string {
    const diagnostic = projectScrapingDiagnostic(error);
    if (diagnostic.category === 'permission') {
        diagnostic.category =
            diagnostic.accessReason === 'unknown-forbidden'
                ? 'GitHub access forbidden; exact reason unconfirmed'
                : 'GitHub permission denied';
    } else if (diagnostic.category === 'authentication') {
        diagnostic.category = 'GitHub authentication failed';
    } else if (diagnostic.category === 'primary rate limit') {
        diagnostic.category = 'GitHub primary rate limit exhausted';
    } else if (diagnostic.category === 'secondary rate limit') {
        diagnostic.category = 'GitHub secondary rate limit reached';
    } else if (diagnostic.category === 'not found') {
        diagnostic.category = 'GitHub resource not found';
    } else if (diagnostic.category === 'invalid-request') {
        diagnostic.category = 'GitHub request was invalid';
    } else if (diagnostic.category === 'conflict') {
        diagnostic.category = 'GitHub reported a conflict';
    } else if (diagnostic.category === 'gone') {
        diagnostic.category = 'GitHub resource is gone';
    } else if (diagnostic.category === 'precondition-failed') {
        diagnostic.category = 'GitHub request precondition failed';
    } else if (diagnostic.category === 'legal-restriction') {
        diagnostic.category = 'GitHub reports legal unavailability';
    } else if (diagnostic.category === 'request-timeout') {
        diagnostic.category = 'GitHub request timed out';
    } else if (diagnostic.category === 'server-error') {
        diagnostic.category = 'GitHub server error';
    } else if (diagnostic.category === 'unexpected-http-status') {
        diagnostic.category = 'GitHub returned an unexpected HTTP status';
    } else if (diagnostic.category === 'redirect') {
        diagnostic.category = 'GitHub API redirect rejected';
    } else if (diagnostic.category === 'other') {
        diagnostic.category = 'GitHub request failed';
    } else if (diagnostic.category === 'network') {
        diagnostic.category = 'GitHub network request failed';
    } else if (diagnostic.category === 'timeout') {
        diagnostic.category = 'GitHub network request timed out';
    } else if (diagnostic.category === 'invalid-json') {
        diagnostic.category = 'GitHub returned invalid JSON';
    } else if (diagnostic.category === 'data-validation') {
        diagnostic.category = 'repository data validation failed';
    } else if (diagnostic.category === 'database-write') {
        diagnostic.category = 'repository database batch failed';
    } else if (diagnostic.category.startsWith('database-preflight-')) {
        diagnostic.category = `database preflight ${diagnostic.category.slice('database-preflight-'.length).replaceAll('-', ' ')}`;
    } else if (diagnostic.category === 'database') {
        diagnostic.category = 'database operation failed';
    } else if (diagnostic.category === 'unexpected') {
        diagnostic.category = 'unexpected scraping error';
    } else if (diagnostic.category === 'interrupted') {
        diagnostic.category =
            diagnostic.cancellationSource === 'caller'
                ? 'scraping cancelled by caller'
                : `scraping interrupted by ${diagnostic.cancellationSource ?? 'cancellation'}`;
        diagnostic.cancellationSource = undefined;
    }
    return formatScrapingDiagnostic(diagnostic);
}
