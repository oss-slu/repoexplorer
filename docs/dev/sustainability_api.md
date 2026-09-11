# Sustainability API

The API exposes the Sustainability dashboard data at `/sustainability`. The
root response contains these seven properties, and each property is also
available as a wrapped response from its suffix endpoint:

- `GET /sustainability/sustainabilityIndicatorsPerUniversity`
- `GET /sustainability/avgContributors`
- `GET /sustainability/avgBusFactor`
- `GET /sustainability/communityFiles`
- `GET /sustainability/communityFilesByStars`
- `GET /sustainability/busFactorDistribution`
- `GET /sustainability/contributorCountDistribution`

The scalar values are numbers. University indicator rows contain `name`,
`avgContributors`, and `avgBusFactor`. Community file rows contain `name`,
`total`, `percentage`, and one numeric count for each observed project type.
Star heatmap rows contain `name` and the five columns `0-10`, `11-50`,
`51-100`, `101-200`, and `>200`. Distribution rows contain `name`, `value`
(repository count), and `percentage`.

All percentages use a 0–100 scale and are rounded to one decimal place.
Headline averages use all available finite observations and are not rounded.
Community-file percentages use the filtered repository count as their
denominator; heatmap percentages use the repository count in each star bucket.
Distribution percentages use the filtered repository count, so missing or
invalid numeric observations remain in the denominator but are not counted.

The supported filters are `university`, `language`, `license`, and
`typePredictionGpt5Mini`. Values are case-insensitive; repeated values for one
field are ORed, while different fields are ANDed. Unsupported query keys are
ignored. An empty filtered result returns zero for both averages and empty
arrays for the five array properties.

The heatmap follows the executable source behavior and includes all filtered
project types. Existing dashboard help describes it as DEV-only; clients that
need a DEV-only view can use the project-type filter.
