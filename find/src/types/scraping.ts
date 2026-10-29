import type { ScrapingPhase } from './progress';

export type ScrapingCancellationSource = 'SIGINT' | 'SIGTERM' | 'caller';

export type SearchQueries = {
    repositories?: string;
    organizations?: string;
    users?: string;
};

export type UniversityConfiguration = {
    key: string;
    fullName: string;
    acronym: string;
    queries?: SearchQueries;
};

export type ScrapingConfiguration = {
    universities: UniversityConfiguration[];
    repositoryConcurrency: number;
    databaseBatchSize: number;
};

export type ScrapingPolicy = 'best-effort' | 'strict';

export type CollectionMode = 'full' | 'refresh';

/** Kept as an alias for callers that used the original owner-only policy name. */
export type OwnerListingPolicy = ScrapingPolicy;

export type SkippedOwner = {
    university: string;
    login: string;
    ownerType: 'Organization' | 'User';
    endpoint: string;
    status: 404;
    reason: string;
};

type SkippedRepositoryBase = {
    university: string;
    repositoryId: number;
    repositoryName: string;
    endpoint: string;
    requestId?: string;
    reason: string;
};

export type SkippedRepository =
    | (SkippedRepositoryBase & {
          status: 403;
          reasonCode: 'github_tos_block';
      })
    | (SkippedRepositoryBase & {
          status: 403;
          reasonCode: 'github_contributors_unavailable';
      })
    | (SkippedRepositoryBase & {
          status: 404;
          reasonCode: 'repository_unavailable_404';
      })
    | (SkippedRepositoryBase & {
          status: 451;
          reasonCode: 'github_legal_restriction';
      });

export type ScrapingWarning = {
    university: string;
    repositoryId: number;
    repositoryName: string;
    field: string;
    replacementCount: number;
    code: 'nul_replaced';
};

export type RepositoryCandidate = {
    id: number;
    fullName: string;
    /** Repository fields projected from search or owner listing metadata, when available. */
    metadata?: unknown;
    /** Descriptive-text normalization warnings collected before checkpointing metadata. */
    metadataWarnings?: ScrapingWarning[];
    /** Stored entity tag used only by conditional refresh requests. */
    etag?: string;
};

export type RepositoryCollectionCheckpoint = {
    candidate: RepositoryCandidate;
    status: 'pending' | 'complete' | 'unchanged' | 'skipped';
    record?: RepositoryScrapingRecord;
    skippedRepository?: SkippedRepository;
    etag?: string;
    warnings?: ScrapingWarning[];
};

export type UniversityCollectionCheckpoint = {
    mode: CollectionMode;
    status: 'discovering' | 'ready' | 'complete';
    discovered: number;
    committed: number;
    candidates: RepositoryCollectionCheckpoint[];
    skippedOwners: SkippedOwner[];
    skippedRepositories: SkippedRepository[];
    warnings: ScrapingWarning[];
};

/**
 * Raw GitHub fields plus enrichment stored before downstream classification.
 * Derived fields are nullable because scraping does not calculate them.
 */
export type RepositoryScrapingRecord = {
    university: string;
    id: number;
    fullName: string | null;
    owner: string;
    license: string | null;
    language: string | null;
    htmlUrl: string | null;
    description: string | null;
    fork: 0 | 1;
    createdAt: string | null;
    updatedAt: string | null;
    pushedAt: string | null;
    homepage: string | null;
    size: number;
    stargazersCount: number;
    readme: string | null;
    watchersCount: number;
    forksCount: number;
    openIssuesCount: number;
    watchers: number;
    organization: string | null;
    releaseDownloads: number;
    contributors: string;
    contributorCount: number;
    busFactor: number | null;
    codeOfConductFile: string | null;
    contributing: string | null;
    securityPolicy: string | null;
    issueTemplates: string | null;
    pullRequestTemplate: string | null;
    subscribersCount: number;
    affiliationPredictionGpt5Mini: number | null;
    typePredictionGpt5Mini: string | null;
    scrapedAt: string;
};

export type ScrapeUniversityResult = {
    status: 'complete' | 'partial';
    university: string;
    discovered: number;
    committed: number;
    skippedOwners: SkippedOwner[];
    skippedRepositories: SkippedRepository[];
    warnings: ScrapingWarning[];
};

export type ScrapeUniversityFailure = {
    status: 'failed';
    university: string;
    discovered?: number;
    error: Error;
    skippedOwners: SkippedOwner[];
    skippedRepositories: SkippedRepository[];
    warnings: ScrapingWarning[];
};

export type ScrapeUniversityInterruption = {
    status: 'interrupted';
    university: string;
    discovered?: number;
    cancellationSource: ScrapingCancellationSource;
    phase?: ScrapingPhase;
    owner?: string;
    repository?: string;
    detail?: string;
    skippedOwners: SkippedOwner[];
    skippedRepositories: SkippedRepository[];
    warnings: ScrapingWarning[];
};

export type ScrapeUniversityOutcome =
    | ScrapeUniversityResult
    | ScrapeUniversityFailure
    | ScrapeUniversityInterruption
    | { status: 'not_run'; university: string };

export type ScrapingRunResult = {
    elapsedMs: number;
    universitiesProcessed: number;
    committed: number;
    failed: number;
    interrupted: number;
    partial: number;
    results: ScrapeUniversityResult[];
    failures: ScrapeUniversityFailure[];
    outcomes: ScrapeUniversityOutcome[];
};
