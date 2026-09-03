export type nameValue = { name: string, value: number };
export type nameValueArr = nameValue[];
export type nameMultiVal = { name: string, [key: string]: string | number };
export type nameMultiValArr = nameMultiVal[];

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