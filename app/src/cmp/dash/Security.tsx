import HeatmapTable from '../charts/HeatmapTable';
import DataTable from '../charts/DataTable';

type SecurityProps = {
    filters: Record<string, string | number>;
};

export default function Security({ filters }: SecurityProps) {
    const { license, ...otherFilters } = filters;

    const securityFilters = {
        ...otherFilters,
        ...(license !== undefined ? { repoLicense: license } : {}),
    };

    return (
        <div className="dashboard">
            <div className="dashboard-top-row dashboard-top-row--wide-left">
                <DataTable
                    title="Security scorecard by repository (OpenSSF Scorecard)"
                    endpoint="security/securityScorecardByRepo"
                    scrollable
                    filters={securityFilters}
                />

                <HeatmapTable
                    title="Average score per Security Metric"
                    endpoint="security/avgScorePerMetric"
                    filters={securityFilters}
                />
            </div>
        </div>
    );
}
