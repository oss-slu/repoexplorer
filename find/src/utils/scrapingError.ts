import type { ScrapingPhase } from '../types/progress';
import type { SkippedRepository } from '../types/scraping';

export interface ScrapingErrorContext {
    phase: ScrapingPhase;
    university?: string;
    owner?: string;
    repository?: string;
    detail?: string;
}

export type DatabasePreflightFailure =
    | 'connection'
    | 'missing-table'
    | 'missing-columns'
    | 'privileges';

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
