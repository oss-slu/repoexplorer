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
    emailDomains?: string[];
    additionalQueries?: string[];
    affiliationDefinition?: string;
    /**
     * Other names people write for this institution (for example
     * "UC Santa Cruz"). The affiliation evidence gate treats each like the
     * full name.
     */
    alternateNames?: string[];
    /**
     * Names of other institutions that contain this one's name or acronym
     * (for example "Saint Louis University Baguio"). Evidence mentioning one
     * never satisfies the affiliation evidence gate.
     */
    excludedNames?: string[];
    queries?: SearchQueries;
};

export type TextTruncationConfiguration = {
    mode: 'start' | 'start_end';
    maxChars: number;
    startChars: number;
    endChars: number;
};

export type ResponseFormatMode = 'json_schema' | 'json_object' | 'text';

export const REASONING_EFFORTS = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ClassificationGenerationSettings = {
    responseFormat: ResponseFormatMode;
    /** Omitted from requests when unset; GPT-5 reasoning models reject any value other than their default. */
    temperature?: number;
    /** With `max_completion_tokens`, this budget includes reasoning tokens. */
    maxOutputTokens: number;
    maxOutputTokensField: 'max_tokens' | 'max_completion_tokens';
    /** Sent as `reasoning_effort` only when set. */
    reasoningEffort?: ReasoningEffort;
    seed?: number;
};

export type ClassificationCitationMode = 'exact_quote' | 'evidence_id';

/**
 * `names_institution` downgrades a supported affiliation to uncertain unless
 * one of its accepted citations names the institution; `off` keeps the
 * model's decision.
 */
export type AffiliationEvidenceGate = 'names_institution' | 'off';

export type ClassificationConfiguration = {
    provider: string;
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    threshold: number;
    concurrency: number;
    timeoutMs: number;
    maxRetries: number;
    promptVersion: string;
    citationMode: ClassificationCitationMode;
    affiliationEvidenceGate: AffiliationEvidenceGate;
    truncation: TextTruncationConfiguration;
    generation: ClassificationGenerationSettings;
};

export type ScrapingConfiguration = {
    universities: UniversityConfiguration[];
    repositoryConcurrency: number;
    databaseBatchSize: number;
    /** Defaults to `graphql` when the client is authenticated; `rest` restores per-repository REST reads. */
    enrichmentApi?: EnrichmentApi;
    classification?: ClassificationConfiguration;
};

export type EnrichmentApi = 'graphql' | 'rest';

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
    /** Published contributor list and the ETag that revalidates it. */
    contributorCache?: RepositoryContributorCache;
};

/**
 * A published contributor list that one conditional request can revalidate.
 * Only lists that fit in a single, non-full page are cached, because a later
 * page can change without changing the first page's ETag.
 */
export type RepositoryContributorCache = {
    etag: string;
    logins: string[];
};

export type RepositoryCollectionCheckpoint = {
    candidate: RepositoryCandidate;
    status: 'pending' | 'complete' | 'unchanged' | 'skipped';
    record?: RepositoryScrapingRecord;
    skippedRepository?: SkippedRepository;
    etag?: string;
    /** Contributor-list ETag to publish with a complete record, when reusable. */
    contributorsEtag?: string;
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
    archived: boolean | null;
    isTemplate: boolean | null;
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

export type ClassificationTask = 'affiliation' | 'project_type';

export type ClassificationStatus =
    | 'predicted'
    | 'below_threshold'
    | 'not_supported'
    | 'uncertain'
    | 'ineligible'
    | 'skipped_threshold'
    | 'skipped_eligibility'
    | 'skipped_affiliation_failed'
    | 'skipped_affiliation_uncertain'
    | 'skipped_affiliation_rejected'
    | 'failed';

export type ClassificationCandidate = {
    id: number;
    university: string;
    fullName: string | null;
    owner: string;
    htmlUrl: string | null;
    description: string | null;
    readme: string | null;
    homepage: string | null;
    language: string | null;
    license: string | null;
    fork: number;
    archived: boolean | null;
    isTemplate: boolean | null;
    size: number;
    stargazersCount: number;
    forksCount: number;
    contributors: string | null;
};

export type ClassificationPrediction = {
    id: number;
    university: string;
    task: ClassificationTask;
    provider: string;
    model: string;
    promptVersion: string;
    threshold: number;
    inputHash: string;
    score: number | null;
    category: string | null;
    affiliationDecision: 'supported' | 'not_supported' | 'uncertain' | null;
    affiliationRelationship: string | null;
    affiliationEvidence: Array<{ field: string; quote: string }> | null;
    explanation: string | null;
    status: ClassificationStatus;
    simulated: boolean;
    errorMessage: string | null;
    classifiedAt: string;
};

export type ScrapeUniversityResult = {
    status: 'complete' | 'partial';
    university: string;
    discovered: number;
    committed: number;
    /** Repositories kept as published after a 304; they are not rewritten, so `committed` excludes them. */
    unchanged: number;
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
    unchanged: number;
    failed: number;
    interrupted: number;
    partial: number;
    results: ScrapeUniversityResult[];
    failures: ScrapeUniversityFailure[];
    outcomes: ScrapeUniversityOutcome[];
};
