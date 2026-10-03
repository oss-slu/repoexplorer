import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { barDatum, chartProps } from '../../types/charts';

function getHeatmapColor(value: number) {
    const score = Math.max(0, Math.min(10, value));

    if (score <= 5) {
        const green = Math.round((score / 5) * 255);
        return `rgb(255, ${green}, 0)`;
    }

    const red = Math.round(255 - ((score - 5) / 5) * 255);
    return `rgb(${red}, 255, 0)`;
}

export default function HeatmapTable({ title, endpoint }: chartProps) {
    const [data, setData] = useState<barDatum[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!endpoint) return;

        (async () => {
            try {
                const res = await fetch(`${API_URL}/${endpoint}`);

                if (!res.ok) {
                    throw new Error(`Failed to fetch data from ${endpoint}`);
                }

                const json = await res.json();
                const arr: barDatum[] = Object.values(json)[0] as barDatum[];
                setData(arr);
            } catch (err) {
                setError(
                    err instanceof Error ? err.message : 'Failed to load data',
                );
            }
        })();
    }, [endpoint]);

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
            <table>
                <tbody>
                    {data.map((row) => {
                        const value = Number(row.value);

                        return (
                            <tr key={row.name}>
                                <td>{row.name}</td>
                                <td
                                    style={{
                                        backgroundColor:
                                            getHeatmapColor(value),
                                    }}
                                >
                                    {value.toFixed(1)}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}