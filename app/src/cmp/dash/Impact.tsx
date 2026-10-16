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

type ImpactProps = {
    filters: Record<string, string | number>;
};

export default function Impact({ filters }: ImpactProps) {
    const [summary, setSummary] = useState<impactSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const queryString = new URLSearchParams(
        Object.entries(filters)
            .filter(([, value]) => value !== 'All' && value !== '')
            .map(([key, value]) => [key, String(value)]),
    ).toString();

    useEffect(() => {
        const controller = new AbortController();

        const fetchData = async () => {
            try {
                setError(null);
                setSummary(null);

                const resp = await fetch(`${API_URL}/impact?${queryString}`, {
                    signal: controller.signal,
                });

                if (!resp.ok) {
                    throw new Error(
                        `Error fetching impact data: ${resp.status}`,
                    );
                }

                const json: impactSummary = await resp.json();

                if (!controller.signal.aborted) {
                    setSummary(json);
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    return;
                }

                console.error(err);
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to load impact dashboard',
                );
            }
        };

        void fetchData();

        return () => controller.abort();
    }, [queryString]);

    if (error) {
        return <div>Failed to load impact dashboard: {error}</div>;
    }

    if (!summary) {
        return <div>Loading impact dashboard...</div>;
    }

    return (
        <div className="dashboard">
            <div className="dashboard-top-row dashboard-top-row--wide-left">
                <div className="dashboard-table-col">
                    <DataTable
                        title="Impact Indicators per University"
                        endpoint="impact/impactIndicatorsPerUniversity"
                        filters={filters}
                    />
                </div>

                <div className="dashboard-summary-grid">
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

            <div className="dashboard-chart-grid">
                <BarChartDiv
                    title="Stars Distribution"
                    endpoint="impact/starsDistribution"
                    filters={filters}
                />
                <BarChartDiv
                    title="Forks Distribution"
                    endpoint="impact/forksDistribution"
                    filters={filters}
                />
                <BarChartDiv
                    title="Release Downloads Distribution"
                    endpoint="impact/releaseDownloadsDistribution"
                    filters={filters}
                />
                <BarChartDiv
                    title="Contributors Distribution"
                    endpoint="impact/contributorsDistribution"
                    filters={filters}
                />
            </div>
        </div>
    );
}
