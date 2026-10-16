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
import { formatLabel } from '../../utils/formatLabel';

export default function BarChartDiv({
    title,
    endpoint,
    stacked = false,
    horizontal = false,
    seriesKeys,
    seriesLabels,
    filters = {},
}: chartProps & {
    filters?: Record<string, string | number>;
}) {
    const [data, setData] = useState<barDatum[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const queryString = new URLSearchParams(
        Object.entries(filters)
            .filter(
                ([, value]) => value !== 'All' && value !== '' && value !== 0,
            )
            .map(([key, value]) => [key, String(value)]),
    ).toString();

    useEffect(() => {
        if (!endpoint) return;

        const controller = new AbortController();

        const fetchData = async () => {
            try {
                setError(null);
                setData(null);

                const url = `${API_URL}/${endpoint}${
                    queryString ? `?${queryString}` : ''
                }`;

                const res = await fetch(url, {
                    signal: controller.signal,
                });

                if (!res.ok) {
                    throw new Error(`Failed to fetch data from ${endpoint}`);
                }

                const json = await res.json();

                if (controller.signal.aborted) {
                    return;
                }

                const arr: barDatum[] = Array.isArray(json)
                    ? json
                    : (Object.values(json)[0] as barDatum[]);

                setData(arr);
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
    }, [endpoint, queryString]);

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
    const labels = (seriesLabels ?? keys).map(formatLabel);

    return (
        <div
            style={{
                width: '100%',
                margin: '0 auto',
                textAlign: 'center',
                background: '#ffffff',
                border: '1px solid #dee2e6',
                borderRadius: '8px',
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
                paddingTop: '16px',
            }}
        >
            <h2>{title}</h2>
            <ResponsiveContainer width="100%" height={400}>
                <BarChart
                    data={data}
                    layout={horizontal ? 'vertical' : 'horizontal'}
                >
                    <CartesianGrid strokeDasharray="3 3" />
                    {horizontal ? (
                        <>
                            <XAxis type="number" allowDecimals={false} />
                            <YAxis
                                dataKey="name"
                                type="category"
                                width={120}
                                tickFormatter={formatLabel}
                            />
                        </>
                    ) : (
                        <>
                            <XAxis dataKey="name" tickFormatter={formatLabel} />
                            <YAxis type="number" allowDecimals={false} />
                        </>
                    )}
                    <Tooltip
                        labelFormatter={(label) => formatLabel(String(label))}
                    />
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
