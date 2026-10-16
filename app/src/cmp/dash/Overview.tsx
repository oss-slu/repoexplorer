import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { overviewSummary } from '../../types/dash';
import BarChartDiv from '../charts/BarChartDiv';
import DataBlock from '../charts/DataBlock';
import DataTable from '../charts/DataTable';
import PieChartDiv from '../charts/PieChartDiv';

type OverviewProps = {
    filters: Record<string, string | number>;
};

export default function Overview({ filters }: OverviewProps) {
    const [summary, setSummary] = useState<overviewSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    const queryString = new URLSearchParams(
        Object.entries(filters)
            .filter(([, value]) => value !== 'All' && value !== '')
            .map(([key, value]) => [key, String(value)]),
    ).toString();

    useEffect(() => {
        const controller = new AbortController();

        const fetchOverview = async () => {
            try {
                setError(null);

                const resp = await fetch(`${API_URL}/overview?${queryString}`, {
                    signal: controller.signal,
                });

                if (!resp.ok) {
                    throw new Error(`Error fetching overview: ${resp.status}`);
                }

                const json: overviewSummary = await resp.json();

                if (!controller.signal.aborted) {
                    setSummary(json);
                }
            } catch (err) {
                if (controller.signal.aborted) return;

                console.error(err);
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to load overview',
                );
            }
        };

        void fetchOverview();

        return () => controller.abort();
    }, [queryString]);

    if (error) {
        return <div>Failed to load overview: {error}</div>;
    }

    if (!summary) {
        return <div>Loading overview...</div>;
    }

    return (
        <div className="dashboard">
            <div className="dashboard-top-row">
                <div className="dashboard-table-col">
                    <DataTable
                        title="Repositories per University"
                        endpoint="overview/reposPerUniversity"
                        filters={filters}
                    />
                </div>

                <div className="dashboard-summary-grid">
                    <DataBlock
                        header="Total repositories"
                        value={summary.totalRepos ?? 0}
                    />
                    <DataBlock
                        header="Total contributors"
                        value={summary.totalContributors ?? 0}
                    />
                    <DataBlock
                        header="Repositories with a license"
                        value={`${(summary.percentWithLicense ?? 0).toFixed(1)}%`}
                    />
                    <DataBlock
                        header="Average bus factor"
                        value={(summary.avgBusFactor ?? 0).toFixed(1)}
                    />
                </div>
            </div>

            <div className="dashboard-chart-grid">
                <PieChartDiv
                    title="Project Type Distribution"
                    endpoint="overview/typeDistribution"
                    filters={filters}
                />
                <BarChartDiv
                    title="Community Files Presence"
                    endpoint="overview/communityFilesPresence"
                    filters={filters}
                />
                <PieChartDiv
                    title="Language Distribution"
                    endpoint="overview/languageDistribution"
                    filters={filters}
                />
                <PieChartDiv
                    title="License Distribution"
                    endpoint="overview/licenseDistribution"
                    filters={filters}
                />
                <BarChartDiv
                    title="Language Distribution by Type"
                    endpoint="overview/languageDistributionByType"
                    stacked
                    filters={filters}
                />
                <BarChartDiv
                    title="License Distribution by Type"
                    endpoint="overview/licenseDistributionByType"
                    stacked
                    filters={filters}
                />
            </div>
        </div>
    );
}
