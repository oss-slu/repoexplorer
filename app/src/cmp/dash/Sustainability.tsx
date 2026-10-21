import { useEffect, useState } from 'react';
import { API_URL, MAX_VISIBLE_ROWS } from '../../consts';
import { formatLabel } from '../../utils/formatLabel';
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

type SustainabilityProps = {
    filters: Record<string, string[] | number>;
};

export default function Sustainability({ filters }: SustainabilityProps) {
    const [summary, setSummary] = useState<sustainabilitySummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const queryString = new URLSearchParams();

    Object.entries(filters).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            value.forEach((selected) => queryString.append(key, selected));
        } else if (value !== 0) {
            queryString.append(key, String(value));
        }
    });

    const queryParams = queryString.toString();

    useEffect(() => {
        const controller = new AbortController();

        const fetchData = async () => {
            try {
                setError(null);
                setSummary(null);

                const resp = await fetch(
                    `${API_URL}/sustainability?${queryParams}`,
                    {
                        signal: controller.signal,
                    },
                );

                if (!resp.ok) {
                    throw new Error(
                        `Error fetching sustainability: ${resp.status}`,
                    );
                }

                const json: sustainabilitySummary = await resp.json();

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
                        : 'Failed to load sustainability',
                );
            }
        };

        void fetchData();

        return () => controller.abort();
    }, [queryParams]);

    if (error) {
        return <div>Failed to load sustainability: {error}</div>;
    }

    if (!summary) {
        return <div>Loading sustainability...</div>;
    }

    return (
        <div className="dashboard">
            <div className="dashboard-top-row dashboard-top-row--wide-left">
                <div className="dashboard-table-col">
                    <DataTable
                        title="Sustainability Indicators per University"
                        endpoint="sustainability/sustainabilityIndicatorsPerUniversity"
                        filters={filters}
                        showRowMessage
                        scrollable
                        maxRows={MAX_VISIBLE_ROWS}
                    />
                </div>

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
                    filters={filters}
                />
                <div className="community-files-stars dashboard-table-col">
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
                            {(summary.communityFilesByStars ?? []).map(
                                (row) => (
                                    <tr key={row.name}>
                                        <td>{formatLabel(row.name)}</td>
                                        {STAR_RANGES.map((range) => {
                                            const value = Number(
                                                row[range] ?? 0,
                                            );

                                            return (
                                                <td
                                                    key={range}
                                                    style={{
                                                        backgroundColor:
                                                            getHeatmapColor(
                                                                value,
                                                            ),
                                                    }}
                                                >
                                                    {value.toFixed(1)}%
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ),
                            )}
                        </tbody>
                    </table>
                </div>

                <BarChartDiv
                    title="Bus Factor Distribution"
                    endpoint="sustainability/busFactorDistribution"
                    filters={filters}
                />

                <BarChartDiv
                    title="Contributor Count Distribution"
                    endpoint="sustainability/contributorCountDistribution"
                    filters={filters}
                />
            </div>
        </div>
    );
}
