import { parseArgs } from 'node:util';
import { findRecentParquetInDir, getParquet, readParquetFile, parquetToObjects } from '../utils/parquet';
import { query, pool } from '../db/connect';
import type { repoData, secrData } from '../types/appData';

const { values } = parseArgs({
    options: {
        sample: {
            type: 'boolean',
            short: 's',
            default: false,
        },
    },
});

const isSample = values.sample;

const SAMPLE_SECURITY_LIMIT = 100;
const SAMPLE_EXTRA_REPO_LIMIT = 100;
const SAMPLE_REPO_ORGS = [
    'UC-OSPO-Network', 'oss-slu', 'uccross', 'sluseallab', 
    'SLURM-CLI-API-Proxy', 'Fossil-Free-UC-Santa-Cruz', 
    'OSS-PREY', 'Saint-Louis-University', 'UAVLab-SLU', 'slu-dss'
];

async function insertRepositories(data: repoData[]) {
    console.log(`Inserting ${data.length} rows into repositories_parquet...`);
    const sanitize = (val: any) => typeof val === 'string' ? val.replace(/\0/g, '') : val;
    
    for (const repo of data) {
        const text = `
            INSERT INTO public.repositories_parquet (
                university, id, full_name, owner, license, language, html_url, description, 
                fork, created_at, updated_at, pushed_at, homepage, size, stargazers_count, 
                readme, watchers_count, forks_count, open_issues_count, watchers, organization, 
                release_downloads, contributors, contributor_count, bus_factor, code_of_conduct_file, 
                contributing, security_policy, issue_templates, pull_request_template, 
                subscribers_count, affiliation_prediction_gpt5_mini, type_prediction_gpt5_mini
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 
                $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, 
                $29, $30, $31, $32, $33
            ) ON CONFLICT (id, university) DO NOTHING;
        `;
        const values = [
            repo.university, repo.id, repo.fullName, repo.owner, repo.license, repo.language, repo.htmlUrl, sanitize(repo.description),
            repo.fork ? 1 : 0, repo.createdAt, repo.updatedAt, repo.pushedAt, repo.homepage, repo.size, repo.stargazersCount,
            sanitize(repo.readme), repo.watchersCount, repo.forksCount, repo.openIssuesCount, repo.watchers, repo.organization,
            repo.releaseDownloads ?? 0, sanitize(typeof repo.contributors === 'string' ? repo.contributors : JSON.stringify(repo.contributors)), 
            repo.contributorCount ?? 0, repo.busFactor ?? 0, repo.codeOfConductFile, repo.contributing, repo.securityPolicy, 
            repo.issueTemplates, repo.pullRequestTemplate, repo.subscribersCount ?? 0, repo.affiliationPredictionGpt5Mini, repo.typePredictionGpt5Mini
        ];
        await query(text, values);
    }
}

async function insertOrganizations(data: any[]) { 
    console.log(`Inserting ${data.length} rows into organizations_parquet...`);
    for (const org of data) {
        const text = `
            INSERT INTO public.organizations_parquet (
                login, name, description, location, company, email, url, 
                created_at, updated_at, university, affiliation_prediction_orgs
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
            ON CONFLICT (login, university) DO NOTHING;
        `;
        const values = [
            org.login, org.name, org.description, org.location, org.company, org.email, org.url,
            org.createdAt, org.updatedAt, org.university, org.affiliationPredictionOrgs
        ];
        await query(text, values);
    }
}

async function insertSecurity(data: secrData[]) {
    console.log(`Inserting ${data.length} rows into security_parquet...`);
    for (const sec of data) {
        const text = `
            INSERT INTO public.security_parquet (
                html_url, binary_artifacts, branch_protection, ci_tests, cii_best_practices, 
                code_review, contributors, dangerous_workflow, dependency_update_tool, fuzzing, 
                license, maintained, packaging, pinned_dependencies, sast, security_policy, 
                signed_releases, token_permissions, vulnerabilities, total_score
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
            ) ON CONFLICT (html_url) DO NOTHING;
        `;
        const values = [
            sec.htmlUrl, sec.binaryArtifacts, sec.branchProtection, sec.ciTests, sec.ciiBestPractices,
            sec.codeReview, sec.contributors, sec.dangerousWorkflow, sec.dependencyUpdateTool, sec.fuzzing,
            sec.license, sec.maintained, sec.packaging, sec.pinnedDependencies, sec.sast, sec.securityPolicy,
            sec.signedReleases, sec.tokenPermissions, sec.vulnerabilities, sec.totalScore
        ];
        await query(text, values);
    }
}

async function main() {
    try {
        console.log(`Starting Parquet to Postgres migration. Sample mode: ${isSample}`);

        let repoObjs = await parquetToObjects(
            (await readParquetFile(await findRecentParquetInDir('REPO'))) || (await getParquet('REPO'))
        ) as repoData[];
        
        let securityUrls = new Set<string>();
        
        if (isSample) {
            const secrTemp = await parquetToObjects(
                (await readParquetFile(await findRecentParquetInDir('SECR'))) || (await getParquet('SECR'))
            ) as secrData[];
            securityUrls = new Set(secrTemp.map((row) => row.htmlUrl));
            
            repoObjs = [
                ...repoObjs.filter((r) => SAMPLE_REPO_ORGS.includes(r.owner)),
                ...Array.from(
                    new Map(
                        repoObjs.filter(r => !SAMPLE_REPO_ORGS.includes(r.owner) && r.htmlUrl !== null && securityUrls.has(r.htmlUrl))
                                .map(r => [r.htmlUrl, r] as const)
                    ).values()
                ).slice(0, SAMPLE_EXTRA_REPO_LIMIT)
            ];
        }
        await insertRepositories(repoObjs);

        let secrObjs = await parquetToObjects(
            (await readParquetFile(await findRecentParquetInDir('SECR'))) || (await getParquet('SECR'))
        ) as secrData[];
        
        if (isSample) {
            const repoUrls = new Set(repoObjs.map((repo) => repo.htmlUrl));
            secrObjs = secrObjs.filter((sec) => repoUrls.has(sec.htmlUrl)).slice(0, SAMPLE_SECURITY_LIMIT);
        }
        await insertSecurity(secrObjs);

        let orgObjs = await parquetToObjects(
            (await readParquetFile(await findRecentParquetInDir('ORGS'))) || (await getParquet('ORGS'))
        );
        
        if (isSample) {
            orgObjs = orgObjs.slice(0, 100);
        }
        await insertOrganizations(orgObjs);

        console.log('Migration complete!');
    } catch (error) {
        console.error('Error migrating parquet data:', error);
    } finally {
        await pool.end();
    }
}

main();