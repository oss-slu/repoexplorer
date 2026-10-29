import type { ScrapingPhase } from '../types/progress';
import type {
    ScrapingCancellationSource,
    SkippedRepository,
} from '../types/scraping';

export interface ScrapingErrorContext {
    phase: ScrapingPhase;
    university?: string;
    owner?: string;
    repository?: string;
    detail?: string;
}

export type DatabasePreflightFailure =
    'connection' | 'missing-table' | 'missing-columns' | 'privileges';

export class ScrapingCancellationError extends Error {
    constructor(readonly source: ScrapingCancellationSource) {
        super(
            source === 'caller'
                ? 'Scrape cancelled by caller'
                : `Scrape interrupted by ${source}`,
        );
        this.name = 'ScrapingCancellationError';
    }
}

/** Map arbitrary AbortSignal reasons to a bounded, report-safe cancellation. */
export function cancellationForSignal(
    signal: AbortSignal | undefined,
): ScrapingCancellationError | undefined {
    if (!signal?.aborted) return undefined;
    return (
        findScrapingCancellation(signal.reason) ??
        new ScrapingCancellationError('caller')
    );
}

/** Walk wrappers without trusting their messages or looping through cyclic causes. */
export function findScrapingCancellation(
    error: unknown,
): ScrapingCancellationError | undefined {
    const visited = new Set<unknown>();
    let current: unknown = error;
    while (current && !visited.has(current)) {
        visited.add(current);
        if (current instanceof ScrapingCancellationError) return current;
        if (!(current instanceof Error)) return undefined;
        current = current.cause;
    }
    return undefined;
}

export class RepositoryRecordValidationError extends TypeError {
    constructor(
        readonly repository: string,
        readonly field: string,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'RepositoryRecordValidationError';
    }
}

export class RepositoryEnrichmentSkipError extends Error {
    constructor(
        readonly skippedRepository: SkippedRepository,
        options?: ErrorOptions,
    ) {
        super(skippedRepository.reason, options);
        this.name = 'RepositoryEnrichmentSkipError';
    }
}

export function describeSkippedRepositoryReason(
    reasonCode: SkippedRepository['reasonCode'],
): string {
    switch (reasonCode) {
        case 'github_tos_block':
            return 'GitHub blocked repository access for a Terms of Service restriction.';
        case 'github_contributors_unavailable':
            return 'GitHub contributor history exceeds the REST API listing limit.';
        case 'repository_unavailable_404':
            return 'The repository detail endpoint returned HTTP 404 after discovery.';
        case 'github_legal_restriction':
            return 'GitHub returned HTTP 451: repository access is unavailable for legal reasons.';
    }
}

export class ScrapingDatabaseWriteError extends Error {
    constructor(
        readonly batchNumber: number,
        readonly batchSize: number,
        readonly sqlState: string | undefined,
        options?: ErrorOptions,
    ) {
        super('Repository database batch failed', options);
        this.name = 'ScrapingDatabaseWriteError';
    }
}

export class ScrapingDatabasePreflightError extends Error {
    constructor(
        readonly failure: DatabasePreflightFailure,
        readonly sqlState?: string,
        options?: ErrorOptions,
    ) {
        super(preflightMessage(failure), options);
        this.name = 'ScrapingDatabasePreflightError';
    }
}

export class ScrapingContextError extends Error {
    constructor(
        readonly context: ScrapingErrorContext,
        cause: unknown,
    ) {
        super(context.phase, { cause });
        this.name = 'ScrapingContextError';
    }
}

export function withScrapingContext(
    error: unknown,
    context: ScrapingErrorContext,
): ScrapingContextError {
    return new ScrapingContextError(context, error);
}

function preflightMessage(failure: DatabasePreflightFailure): string {
    switch (failure) {
        case 'connection':
            return 'Database preflight could not connect or run its read-only check';
        case 'missing-table':
            return 'Database preflight could not find public.repository_scraping';
        case 'missing-columns':
            return 'Database preflight found missing repository_scraping columns';
        case 'privileges':
            return 'Database preflight found insufficient application-role privileges';
    }
}
