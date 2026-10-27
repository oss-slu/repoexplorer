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
        diagnostic.category = 'GitHub permission denied';
    } else if (diagnostic.category === 'authentication') {
        diagnostic.category = 'GitHub authentication failed';
    } else if (diagnostic.category === 'primary rate limit') {
        diagnostic.category = 'GitHub primary rate limit exhausted';
    } else if (diagnostic.category === 'secondary rate limit') {
        diagnostic.category = 'GitHub secondary rate limit reached';
    } else if (diagnostic.category === 'not found') {
        diagnostic.category = 'GitHub resource not found';
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
    }
    return formatScrapingDiagnostic(diagnostic);
}
