import BarChartDiv from './charts/BarChartDiv';
import DataTable from './charts/DataTable';

export default function Security() {
    return (
        <div className="security-dashboard">
            <DataTable
                title="Security scorecard by repository (OpenSSF Scorecard)"
                endpoint="security/securityScorecardByRepo"
            />

            <BarChartDiv
                title="Average score per Security Metric"
                endpoint="security/avgScorePerMetric"
            />
        </div>
    );
}
