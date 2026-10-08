import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

config({ path: path.resolve(__dirname, '../../.env') });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const HEADERS: Record<string, string> = {
    Authorization: GITHUB_TOKEN ? `token ${GITHUB_TOKEN}` : '',
    Accept: 'application/vnd.github.v3+json',
};

const UNIVERSITY_ACRONYM = 'SLU';
const UNIVERSITY_NAME = 'Saint Louis University';
const BATCH_SIZE = 50;

function getNextLink(headers: Headers): string | null {
    const linkHeader = headers.get('link');
    if (!linkHeader) return null;
    const match = linkHeader
        .split(',')
        .map((part) => part.trim())
        .find((part) => part.endsWith('rel="next"'));
    return match?.match(/<(.*)>/)?.[1] ?? null;
}

async function githubSearch(endpoint: 'repositories' | 'users', query: string) {
    const items: any[] = [];
    let url: string | null = `https://api.github.com/search/${endpoint}?q=${encodeURIComponent(query)}&per_page=100`;

    while (url) {
        try {
            const response: Response = await fetch(url, { headers: HEADERS });
            if (!response.ok) break;
            const data = await response.json();
            items.push(...(data.items ?? []));
            url = getNextLink(response.headers);
        } catch {
            break;
        }
    }

    return items;
}

async function fetchReposForOwnerSequential(owners: { login: string }[]) {
    const repos: string[] = [];
    for (const owner of owners) {
        try {
            const response = await fetch(`https://api.github.com/users/${owner.login}/repos?per_page=100`, {
                headers: HEADERS,
            });
            if (!response.ok) continue;
            const data = await response.json();
            repos.push(...data.map((r: any) => r.full_name));
        } catch {
            continue;
        }
    }
    return repos;
}

async function fetchReposForOwnerConcurrent(owners: { login: string }[]) {
    const repos: string[] = [];
    for (let i = 0; i < owners.length; i += BATCH_SIZE) {
        const batch = owners.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
            batch.map(async (owner) => {
                try {
                    const response = await fetch(`https://api.github.com/users/${owner.login}/repos?per_page=100`, {
                        headers: HEADERS,
                    });
                    if (!response.ok) return [];
                    const data = await response.json();
                    return data.map((r: any) => r.full_name);
                } catch {
                    return [];
                }
            }),
        );
        repos.push(...results.flat());
    }
    return repos;
}

async function scrapeUniversity(mode: 'sequential' | 'concurrent') {
    const start = performance.now();

    const repoQuery = `"${UNIVERSITY_NAME}" in:name,description archived:false size:>0`;
    const orgQuery = `"${UNIVERSITY_ACRONYM}" in:name,login type:Organization`;
    const userQuery = `"${UNIVERSITY_ACRONYM}" in:name,login type:User`;

    const [repoResults, orgResults, userResults] =
        mode === 'concurrent'
            ? await Promise.all([
                  githubSearch('repositories', repoQuery),
                  githubSearch('users', orgQuery),
                  githubSearch('users', userQuery),
              ])
            : [
                  await githubSearch('repositories', repoQuery),
                  await githubSearch('users', orgQuery),
                  await githubSearch('users', userQuery),
              ];

    const owners = [...orgResults, ...userResults].map((o) => ({ login: o.login }));

    const ownerRepos =
        mode === 'concurrent' ? await fetchReposForOwnerConcurrent(owners) : await fetchReposForOwnerSequential(owners);

    return {
        elapsedMs: performance.now() - start,
        directRepoMatches: repoResults.length,
        organizations: orgResults.length,
        users: userResults.length,
        ownerRepos: ownerRepos.length,
    };
}

async function main() {
    if (!GITHUB_TOKEN) {
        console.log(
            "Warning: no GITHUB_TOKEN found. Requests will be unauthenticated and may hit GitHub's low rate limit (60/hour) quickly.\n",
        );
    }

    console.log(`Scraping GitHub for university: ${UNIVERSITY_NAME} (${UNIVERSITY_ACRONYM})\n`);

    console.log('Running sequential pipeline...');
    const seq = await scrapeUniversity('sequential');
    console.log(
        `  -> ${seq.directRepoMatches} repos, ${seq.organizations} orgs, ${seq.users} users, ${seq.ownerRepos} owner repos in ${(seq.elapsedMs / 1000).toFixed(2)}s\n`,
    );

    console.log('Running concurrent pipeline...');
    const conc = await scrapeUniversity('concurrent');
    console.log(
        `  -> ${conc.directRepoMatches} repos, ${conc.organizations} orgs, ${conc.users} users, ${conc.ownerRepos} owner repos in ${(conc.elapsedMs / 1000).toFixed(2)}s\n`,
    );

    if (conc.elapsedMs > 0) {
        console.log(`Speedup: ${(seq.elapsedMs / conc.elapsedMs).toFixed(1)}x faster with async`);
    }
}

main();
