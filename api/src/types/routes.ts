export type nameValue = { name: string, value: number };
export type nameValueArr = nameValue[];
export type nameMultiVal = { name: string, [key: string]: string | number };
export type nameMultiValArr = nameMultiVal[];

// base API response type for providing data for React/Recharts frontend to ingest
export type Resp = { [key: string]: number | nameValueArr | nameMultiValArr };

// /overview route base type
export type RespOverview = {
    totalRepos?: number,
    withLicense?: number,
    percentWithLicense?: number,
    totalContributors?: number,
    avgBusFactor?: number,
    reposPerUniversity?: nameValueArr,
    languageDistribution?: nameValueArr,
    licenseDistribution?: nameValueArr,
    typeDistribution?: nameValueArr,
    communityFilesPresence?: nameValueArr,
    languageDistributionByType?: nameMultiValArr,
    licenseDistributionByType?: nameMultiValArr,
};

// /impact route base type
export type RespImpact = Resp & {};

// /sustainability route base type
export type RespSustainability = Resp & {};

// /security route base type
export type RespSecurity = Resp & {};