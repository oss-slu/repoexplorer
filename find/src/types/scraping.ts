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

export type RepositoryCandidate = {
    id: number;
    fullName: string;
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
    university: string;
    discovered: number;
    committed: number;
};

export type ScrapeUniversityFailure = {
    university: string;
    discovered?: number;
    error: Error;
};

export type ScrapingRunResult = {
    universitiesProcessed: number;
    committed: number;
    failed: number;
    results: ScrapeUniversityResult[];
    failures: ScrapeUniversityFailure[];
};
