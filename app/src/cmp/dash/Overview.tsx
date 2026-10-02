import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { overviewSummary } from '../../types/dash';
import BarChartDiv from '../charts/BarChartDiv';
import DataBlock from '../charts/DataBlock';
import DataTable from '../charts/DataTable';
import PieChartDiv from '../charts/PieChartDiv';

export default function Overview() {
    const [summary, setSummary] = useState<overviewSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const resp = await fetch(`${API_URL}/overview`);

                if (!resp.ok) {
                    throw new Error(`Error fetching overview: ${resp.status}`);
                }

                const json: overviewSummary = await resp.json();
                setSummary(json);
            } catch (err) {
                console.error(err);
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to load overview',
                );
            }
        })();
    }, []);

    if (error) {
        return <div>Failed to load overview: {error}</div>;
    }

    if (!summary) {
        return <div>Loading overview...</div>;
    }

    return (
        <div className="overview-dashboard">
            <div className="overview-top-row">
                <div className="overview-table-col">
                    <DataTable
                        title="Repositories per University"
                        endpoint="overview/reposPerUniversity"
                    />
                </div>

                <div className="overview-summary-grid">
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

            <PieChartDiv
                title="Project Type Distribution"
                endpoint="overview/typeDistribution"
            />
            <BarChartDiv
                title="Community Files Presence"
                endpoint="overview/communityFilesPresence"
            />
            <PieChartDiv
                title="Language Distribution"
                endpoint="overview/languageDistribution"
            />
            <PieChartDiv
                title="License Distribution"
                endpoint="overview/licenseDistribution"
            />
            <BarChartDiv
                title="Language Distribution by Type"
                endpoint="overview/languageDistributionByType"
                stacked
            />
            <BarChartDiv
                title="License Distribution by Type"
                endpoint="overview/licenseDistributionByType"
                stacked
            />
        </div>
    );
}
