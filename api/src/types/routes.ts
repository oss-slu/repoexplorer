export type nameValue = { name: string, value: number };
export type nameValueArr = nameValue[];
export type nameMultiVal = { name: string, [key: string]: string | number };
export type nameMultiValArr = nameMultiVal[];

// /overview route base type
export type RespOverview = {
    totalRepos?: number,
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
export type RespImpact = {};

// /sustainability route base type
export type RespSustainability = {};

// /security route base type
export type RespSecurity = {};