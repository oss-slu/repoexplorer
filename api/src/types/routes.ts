export type nameValue = { name: string, value: number };
export type nameValueArr = nameValue[];

export type RespOverview = {
    totalRepos?: number,
    percentWithLicense?: number,
    totalContributors?: number,
    avgBusFactor?: number,
    reposPerUniversity?: nameValueArr,
    languageDistribution?: nameValueArr,
    licenseDistribution?: nameValueArr,
    typeDistribution?: nameValueArr,
};