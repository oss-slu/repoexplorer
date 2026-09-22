/**
 * Proof-of-concept: async/await vs. synchronous-style GitHub API calls.
 *
 * Demonstrates the speedup available by replacing repofinder's synchronous,
 * one-at-a-time `requests.get()` pattern (see `github_api_request` in
 * `repofinder/scraping/repo_scraping_utils.py`) with concurrent async calls
 * using fetch() + Promise.all().
 *
 * The function being compared, getContributorDetails, mirrors the real
 * Python function of the same name in `repofinder/scraping/get_contributors.py`:
 * one GitHub API call per username, returning a small object of user info.
 *
 * Usage:
 *   npx tsx async_scraping_poc.ts
 *
 * Requires a GITHUB_TOKEN environment variable (or .env file) for
 * authenticated requests, which raises the GitHub API rate limit from
 * 60/hour (unauthenticated) to 5,000/hour.
 */

import 'dotenv/config';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const HEADERS: Record<string, string> = {
    Authorization: GITHUB_TOKEN ? `token ${GITHUB_TOKEN}` : '',
    Accept: 'application/vnd.github.v3+json',
};

// A representative sample of GitHub usernames to fetch details for.
// In the real pipeline this list would be contributors pulled from a
// repository's /contributors endpoint.
const SAMPLE_USERNAMES = [
    'torvalds', 'gvanrossum', 'yyx990803', 'sindresorhus', 'tj',
    'addyosmani', 'gaearon', 'kentcdodds', 'defunkt', 'mojombo',
    'pjhyett', 'wycats', 'ezmobius', 'ivey', 'evanphx',
    'vanpelt', 'wayneeseguin', 'brynary', 'kevinclark', 'technoweenie',
];

interface ContributorDetails {
    login: string | null;
    name: string | null;
    company: string | null;
}

// ---------------------------------------------------------------------------
// SYNCHRONOUS-STYLE VERSION — mirrors the current repofinder pattern
// ---------------------------------------------------------------------------
// This awaits each fetch one at a time, so the next request cannot start
// until the previous one has fully completed — the same behavior as
// repofinder's blocking `requests.get()` loop.

async function getContributorDetailsSequential(
    username: string,
): Promise<ContributorDetails | null> {
    const url = `https://api.github.com/users/${username}`;
    try {
        const response = await fetch(url, { headers: HEADERS });
        if (!response.ok) return null;
        const data = await response.json();
        return {
            login: data.login ?? null,
            name: data.name ?? null,
            company: data.company ?? null,
        };
    } catch {
        return null;
    }
}

async function runSequential(
    usernames: string[],
): Promise<{ results: ContributorDetails[]; elapsedMs: number }> {
    const start = performance.now();
    const results: ContributorDetails[] = [];
    for (const username of usernames) {
        const result = await getContributorDetailsSequential(username);
        if (result) results.push(result);
    }
    const elapsedMs = performance.now() - start;
    return { results, elapsedMs };
}

// ---------------------------------------------------------------------------
// ASYNC VERSION — proposed replacement
// ---------------------------------------------------------------------------
// Same fetch logic, but every request is kicked off together and awaited as
// a batch with Promise.all(), so the wait time overlaps instead of stacking.

async function getContributorDetailsConcurrent(
    username: string,
): Promise<ContributorDetails | null> {
    const url = `https://api.github.com/users/${username}`;
    try {
        const response = await fetch(url, { headers: HEADERS });
        if (!response.ok) return null;
        const data = await response.json();
        return {
            login: data.login ?? null,
            name: data.name ?? null,
            company: data.company ?? null,
        };
    } catch {
        return null;
    }
}

async function runConcurrent(
    usernames: string[],
): Promise<{ results: ContributorDetails[]; elapsedMs: number }> {
    const start = performance.now();
    const settled = await Promise.all(
        usernames.map((username) => getContributorDetailsConcurrent(username)),
    );
    const results = settled.filter((r): r is ContributorDetails => r !== null);
    const elapsedMs = performance.now() - start;
    return { results, elapsedMs };
}

// ---------------------------------------------------------------------------
// COMPARISON
// ---------------------------------------------------------------------------

async function main() {
    if (!GITHUB_TOKEN) {
        console.log(
            'Warning: no GITHUB_TOKEN found. Requests will be unauthenticated ' +
                'and may hit GitHub\'s low rate limit (60/hour) quickly.\n',
        );
    }

    console.log(`Fetching details for ${SAMPLE_USERNAMES.length} users...\n`);

    console.log('Running sequential version (current repofinder pattern)...');
    const seq = await runSequential(SAMPLE_USERNAMES);
    console.log(
        `  -> ${seq.results.length} succeeded in ${(seq.elapsedMs / 1000).toFixed(2)}s\n`,
    );

    console.log('Running concurrent version (proposed fetch + Promise.all)...');
    const conc = await runConcurrent(SAMPLE_USERNAMES);
    console.log(
        `  -> ${conc.results.length} succeeded in ${(conc.elapsedMs / 1000).toFixed(2)}s\n`,
    );

    if (conc.elapsedMs > 0) {
        const speedup = seq.elapsedMs / conc.elapsedMs;
        console.log(`Speedup: ${speedup.toFixed(1)}x faster with async`);
    }
    console.log(
        '\nNote: actual speedup on the full scraping pipeline should be even ' +
            'larger, since real usage involves thousands of calls per university ' +
            'rather than the small sample used here.',
    );
}

main();