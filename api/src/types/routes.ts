import type { secrData } from './appData';
export type nameValue = { name: string; value: number };
export type nameValueArr = nameValue[];
export type nameMultiVal = { name: string; [key: string]: string | number };
export type nameMultiValArr = nameMultiVal[];

// base API response type for providing data for React/Recharts frontend to ingest
export type Resp = { [key: string]: number | nameValueArr | nameMultiValArr };

// /overview route base type
export type RespOverview = {
    totalRepos?: number;
    withLicense?: number;
    percentWithLicense?: number;
    totalContributors?: number;
    avgBusFactor?: number;
    reposPerUniversity?: nameValueArr;
    languageDistribution?: nameValueArr;
    licenseDistribution?: nameValueArr;
    typeDistribution?: nameValueArr;
    communityFilesPresence?: nameValueArr;
    languageDistributionByType?: nameMultiValArr;
    licenseDistributionByType?: nameMultiValArr;
};

// /impact route base type
export type RespImpact = Resp & {
    totalStars?: number;
    totalForks?: number;
    totalDownloads?: number;
    totalContributors?: number;
    impactIndicatorsPerUniversity?: nameMultiValArr;
    starsDistribution?: nameValueArr;
    forksDistribution?: nameValueArr;
    releaseDownloadsDistribution?: nameValueArr;
    contributorsDistribution?: nameValueArr;
};

// /sustainability route base type
export type sustainabilityIndicator = {
    name: string;
    avgContributors: number;
    avgBusFactor: number;
};

export type sustainabilityCommunityFile = {
    name: string;
    total: number;
    percentage: number;
    [projectType: string]: string | number;
};

export type sustainabilityCommunityFileByStars = {
    name: string;
    '0-10': number;
    '11-50': number;
    '51-100': number;
    '101-200': number;
    '>200': number;
};

export type sustainabilityDistribution = {
    name: string;
    value: number;
    percentage: number;
};

export type respSustainability = {
    sustainabilityIndicatorsPerUniversity: sustainabilityIndicator[];
    avgContributors: number;
    avgBusFactor: number;
    communityFiles: sustainabilityCommunityFile[];
    communityFilesByStars: sustainabilityCommunityFileByStars[];
    busFactorDistribution: sustainabilityDistribution[];
    contributorCountDistribution: sustainabilityDistribution[];
};

// /security route base type
export type RespSecurity = {
    securityScorecardByRepo?: secrData[];
    avgScorePerMetric?: nameValueArr;
};
