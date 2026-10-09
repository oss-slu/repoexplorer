import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import BarChartDiv from '../charts/BarChartDiv';
import DataBlock from '../charts/DataBlock';
import DataTable from '../charts/DataTable';

type impactSummary = {
    totalStars?: number;
    totalForks?: number;
    totalDownloads?: number;
    totalContributors?: number;
};

export default function Impact() {
    const [summary, setSummary] = useState<impactSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const resp = await fetch(`${API_URL}/impact`);

                if (!resp.ok) {
                    throw new Error(`Error fetching impact data: ${resp.status}`);
                }

                const json: impactSummary = await resp.json();
                setSummary(json);
            } catch (err) {
                console.error(err);
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to load impact dashboard',
                );
            }
        })();
    }, []);

    if (error) {
        return <div>Failed to load impact dashboard: {error}</div>;
    }

    if (!summary) {
        return <div>Loading impact dashboard...</div>;
    }

    return (
        <div className="overview-dashboard">
            <div className="overview-top-row">
                <div className="overview-table-col">
                    <DataTable
                        title="Impact Indicators per University"
                        endpoint="impact/impactIndicatorsPerUniversity"
                    />
                </div>

                <div className="overview-summary-grid">
                    <DataBlock
                        header="Total stars"
                        value={summary.totalStars ?? 0}
                    />
                    <DataBlock
                        header="Total forks"
                        value={summary.totalForks ?? 0}
                    />
                    <DataBlock
                        header="Total downloads"
                        value={summary.totalDownloads ?? 0}
                    />
                    <DataBlock
                        header="Total contributors"
                        value={summary.totalContributors ?? 0}
                    />
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', width: '100%' }}>
                <BarChartDiv
                    title="Stars Distribution"
                    endpoint="impact/starsDistribution"
                />
                <BarChartDiv
                    title="Forks Distribution"
                    endpoint="impact/forksDistribution"
                />
                <BarChartDiv
                    title="Release Downloads Distribution"
                    endpoint="impact/releaseDownloadsDistribution"
                />
                <BarChartDiv
                    title="Contributors Distribution"
                    endpoint="impact/contributorsDistribution"
                />
            </div>
        </div>
    );
}