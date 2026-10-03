import HeatmapTable from '../charts/HeatmapTable';
import DataTable from '../charts/DataTable';

export default function Security() {
    return (
        <div className="dashboard">
            <div className="dashboard-top-row dashboard-top-row--wide-left">
                <DataTable
                    title="Security scorecard by repository (OpenSSF Scorecard)"
                    endpoint="security/securityScorecardByRepo"
                    maxRows={10}
                />

                <HeatmapTable
                    title="Average score per Security Metric"
                    endpoint="security/avgScorePerMetric"
                />
            </div>
        </div>
    );
}
