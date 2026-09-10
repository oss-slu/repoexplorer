import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { repoData, orgsData, secrData } from './types/appData';

// PATHS RELATIVE TO /api
// consts.ts MUST remain at /api/src/consts.ts for this to work
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const API_ROOT = path.resolve(__dirname, '..');
export const PARQUET_DATA_DIR = path.join(API_ROOT, 'data');

export const VITE_ORIGIN = 'http://localhost:6284';
export const PORT = 8765;

// The UC OSPO Network publishes a static parquet file with the Github data at this public S3 bucket.
const UCOSPO_S3 = 'https://repoexplorer-data.s3.amazonaws.com';
export const UCOSPO_REPO_PARQ_S3_URL = `${UCOSPO_S3}/repositories_reduced_affiliated.parquet`;
export const UCOSPO_SECR_PARQ_S3_URL = `${UCOSPO_S3}/security_reduced_affiliated.parquet`;
export const UCOSPO_ORGS_PARQ_S3_URL = `${UCOSPO_S3}/organizations_reduced_affiliated.parquet`;

// base API routes
export const BASE_OVERVIEW = '/overview';
export const BASE_IMPACT = '/impact';
export const BASE_SUSTAINABILITY = '/sustainability';
export const BASE_SECURITY = '/security';
export const BASE_ORGANIZATION = '/organization';

export const FILTERABLE_REPO_FIELDS: Partial<Record<keyof repoData, 'exact'>> = {
    university: 'exact',
    language: 'exact',
    license: 'exact',
    typePredictionGpt5Mini: 'exact',
};

export const FILTERABLE_SECR_FIELDS: Partial<Record<keyof secrData, 'exact'>> = {
    license: 'exact',
};

export const FILTERABLE_ORGS_FIELDS: Partial<Record<keyof orgsData, 'exact'>> = {
    university: 'exact',
};