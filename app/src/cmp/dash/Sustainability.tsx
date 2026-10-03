import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import BarChartDiv from '../charts/BarChartDiv';
import DataBlock from '../charts/DataBlock';
import DataTable from '../charts/DataTable';

type communityFilesByStarsDatum = {
    name: string;
    [key: string]: string | number;
};

type sustainabilitySummary = {
    avgContributors?: number;
    avgBusFactor?: number;
    communityFilesByStars?: communityFilesByStarsDatum[];
};

const STAR_RANGES = ['0-10', '11-50', '51-100', '101-200', '>200'];

function getHeatmapColor(value: number) {
    const percentage = Math.max(0, Math.min(100, value));

    if (percentage <= 50) {
        const green = Math.round((percentage / 50) * 255);
        return `rgb(255, ${green}, 0)`;
    }

    const red = Math.round(255 - ((percentage - 50) / 50) * 255);
    return `rgb(${red}, 255, 0)`;
}

export default function Sustainability() {
    const [summary, setSummary] = useState<sustainabilitySummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const resp = await fetch(`${API_URL}/sustainability`);

                if (!resp.ok) {
                    throw new Error(
                        `Error fetching sustainability: ${resp.status}`,
                    );
                }

                const json: sustainabilitySummary = await resp.json();
                setSummary(json);
            } catch (err) {
                console.error(err);
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to load sustainability',
                );
            }
        })();
    }, []);

    if (error) {
        return <div>Failed to load sustainability: {error}</div>;
    }

    if (!summary) {
        return <div>Loading sustainability...</div>;
    }

    return (
        <div className="dashboard">
            <div className="dashboard-top-row dashboard-top-row--wide-left">
                <DataTable
                    title="Sustainability Indicators per University"
                    endpoint="sustainability/sustainabilityIndicatorsPerUniversity"
                />

                <div className="dashboard-summary-grid dashboard-summary-grid--single-column">
                    <DataBlock
                        header="Average bus factor"
                        value={(summary.avgBusFactor ?? 0).toFixed(1)}
                    />
                    <DataBlock
                        header="Average # contributors"
                        value={(summary.avgContributors ?? 0).toFixed(1)}
                    />
                </div>
            </div>

            <div className="dashboard-chart-grid">
                <BarChartDiv
                    title="Community Files"
                    endpoint="sustainability/communityFiles"
                    stacked
                    seriesKeys={['DEV', 'DOCS', 'EDU', 'WEB']}
                />
                <div className="community-files-stars">
                    <h2>Community Files by # Stars</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Community File</th>
                                {STAR_RANGES.map((range) => (
                                    <th key={range}>{range}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {(summary.communityFilesByStars ?? []).map((row) => (
                                <tr key={row.name}>
                                    <td>{row.name}</td>
                                    {STAR_RANGES.map((range) => {
                                        const value = Number(row[range] ?? 0);

                                        return (
                                            <td
                                                key={range}
                                                style={{
                                                    backgroundColor:
                                                        getHeatmapColor(value),
                                                }}
                                            >
                                                {value.toFixed(1)}%
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <BarChartDiv
                    title="Bus Factor Distribution"
                    endpoint="sustainability/busFactorDistribution"
                />

                <BarChartDiv
                    title="Contributor Count Distribution"
                    endpoint="sustainability/contributorCountDistribution"
                />
            </div>
        </div>
    );
}
