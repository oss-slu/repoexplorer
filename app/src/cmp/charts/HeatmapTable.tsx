import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { barDatum, chartProps } from '../../types/charts';
import { formatLabel } from '../../utils/formatLabel';

function getHeatmapColor(value: number) {
    const score = Math.max(0, Math.min(10, value));

    if (score <= 5) {
        const green = Math.round((score / 5) * 255);
        return `rgb(255, ${green}, 0)`;
    }

    const red = Math.round(255 - ((score - 5) / 5) * 255);
    return `rgb(${red}, 255, 0)`;
}

type HeatmapTableProps = chartProps & {
    filters?: Record<string, string[] | number>;
};

export default function HeatmapTable({
    title,
    endpoint,
    filters = {},
}: HeatmapTableProps) {
    const [data, setData] = useState<barDatum[] | null>(null);
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
        if (!endpoint) return;

        const controller = new AbortController();

        const fetchData = async () => {
            try {
                setError(null);
                setData(null);

                const res = await fetch(
                    `${API_URL}/${endpoint}${queryParams ? `?${queryParams}` : ''}`,
                    {
                        signal: controller.signal,
                    },
                );

                if (!res.ok) {
                    throw new Error(`Failed to fetch data from ${endpoint}`);
                }

                const json = await res.json();
                const arr: barDatum[] = Object.values(json)[0] as barDatum[];

                if (!controller.signal.aborted) {
                    setData(arr);
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    return;
                }

                setError(
                    err instanceof Error ? err.message : 'Failed to load data',
                );
            }
        };

        void fetchData();

        return () => controller.abort();
    }, [endpoint, queryParams]);

    if (error) {
        return (
            <div>
                Failed to load {title}: {error}
            </div>
        );
    }

    if (!data) {
        return <div>Loading {title}...</div>;
    }

    return (
        <div className="heatmap-table">
            <h2>{title}</h2>
            <table aria-label={`${title} heatmap`}>
                <thead>
                    <tr>
                        <th 
                            className="heatmap-row-heading"
                            scope="col"
                            aria-label="Security metric"
                        />
                        <th 
                            className="heatmap-tick-spacer"
                            scope="col"
                        />
                        <th className="heatmap-column-heading" scope="col">
                            Metric averages
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((row) => {
                        const value = Number(row.value);

                        return (
                            <tr key={row.name}>
                                <th className="heatmap-row-label" scope="row">
                                    {formatLabel(row.name)}
                                </th>
                                <td className="heatmap-tick-cell">
                                    <span aria-hidden="true" />
                                </td>
                                <td
                                    className="heatmap-score-cell"
                                    style={{
                                        backgroundColor: getHeatmapColor(value),
                                    }}
                                >
                                    {value.toFixed(1)}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot>
                    <tr>
                        <td colSpan={2} />
                        <td className="heatmap-average-axis">
                            <span
                                className="heatmap-average-tick"
                                aria-hidden="true"
                            />
                            <span className="heatmap-average-label">
                                Average
                            </span>
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}
