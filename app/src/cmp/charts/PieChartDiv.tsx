import { useEffect, useState } from 'react';
import {
    Legend,
    Pie,
    PieChart,
    ResponsiveContainer,
    Sector,
    Tooltip,
} from 'recharts';
import { API_URL, PIE_COLORS } from '../../consts';
import type { chartProps, pieSlice } from '../../types/charts';

export default function PieChartDiv({
    title,
    endpoint,
    filters = {},
}: chartProps & {
    filters?: Record<string, string | number>;
}) {
    const [data, setData] = useState<{ name: string; value: number }[] | null>(
        null,
    );
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
                setData(null);

                const url = `${API_URL}/${endpoint}${
                    queryString ? `?${queryString}` : ''
                }`;

                const resp = await fetch(url, {
                    signal: controller.signal,
                });

                if (!resp.ok) {
                    throw new Error(`Error fetching data: ${resp.status}`);
                }

                const json = await resp.json();

                if (controller.signal.aborted) {
                    return;
                }

                const arr: pieSlice[] = Array.isArray(json)
                    ? json
                    : (Object.values(json)[0] as pieSlice[]);

                const withColors = arr.map((d, i) => ({
                    ...d,
                    fill: PIE_COLORS[i % PIE_COLORS.length],
                }));

                setData(withColors);
            } catch (err) {
                if (controller.signal.aborted) {
                    return;
                }

                console.error(err);
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

    return (
        <div
            className="dashboard-table-col"
            style={{
                width: '100%',
                margin: '0 auto',
                textAlign: 'center',
            }}
        >
            <h2>{title}</h2>
            <ResponsiveContainer width="100%" height={400}>
                <PieChart title="test">
                    <Pie
                        data={data}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={140}
                        label={({ name, percent }) =>
                            `${name} ${(percent! * 100).toFixed(1)}%`
                        }
                        shape={(props) => (
                            <Sector
                                {...props}
                                fill={
                                    PIE_COLORS[
                                        ((props as { index?: number }).index ??
                                            0) % PIE_COLORS.length
                                    ]
                                }
                            />
                        )}
                    ></Pie>
                    <Legend />
                    <Tooltip
                        formatter={(value, name) => [
                            `${(
                                (typeof value === 'number'
                                    ? value
                                    : Number(value ?? 0)) * 100
                            ).toFixed(2)}%`,
                            String(name),
                        ]}
                    />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}
