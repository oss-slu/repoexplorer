import { useEffect, useState } from 'react';
import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis, 
} from 'recharts';
import { API_URL, PIE_COLORS } from '../../consts';
import type { barDatum, chartProps } from '../../types/charts';

export default function BarChartDiv({
    title,
    endpoint,
    stacked = false,
    seriesKeys,
    seriesLabels,
}: chartProps) {
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
              const arr: barDatum[] = Object.values(json)[0] as barDatum[];              setData(arr);
            } catch (err) {
                setError(
                    err instanceof Error ? err.message : 'Failed to load data',
                );
            }
        })();
    }, [endpoint]);

    if (error)
        return (
            <div>
                Failed to load {title}: {error}
            </div>
        );
    if (!data) return <div>Loading {title}...</div>;

    const keys = stacked
        ? (seriesKeys ?? Object.keys(data[0] ?? {}).filter((k) => k !== 'name'))
        : ['value'];
    const labels = seriesLabels ?? keys;

    return (
        <div
            style={{
                width: '75vw',
                margin: '0 auto',
                textAlign: 'center',
                border: '2px solid black',
            }}
        >
            <h2>{title}</h2>
            <ResponsiveContainer width="100%" height={400}>
                <BarChart data={data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    {keys.length > 1 && <Legend />}
                    {keys.map((key, i) => (
                        <Bar
                            key={key}
                            dataKey={key}
                            name={labels[i] ?? key}
                            fill={PIE_COLORS[i % PIE_COLORS.length]}
                            stackId={stacked ? 'stack' : undefined}
                        />
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}