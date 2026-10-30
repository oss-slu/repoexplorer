import { useEffect, useState } from 'react';
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    LabelList,
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
    xLabel,
    yLabel,
    valueSuffix = '',
    filters = {},
}: chartProps & {
    filters?: Record<string, string[] | number>;
}) {
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

                const url = `${API_URL}/${endpoint}${
                    queryParams ? `?${queryParams}` : ''
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
    }, [endpoint, queryParams]);

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

    const formatValue = (v: unknown) =>
        typeof v === 'number' ? `${v.toFixed(1)}${valueSuffix}` : String(v);

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
            <ResponsiveContainer width="100%" height={460}>
                <BarChart
                    data={data}
                    layout={horizontal ? 'vertical' : 'horizontal'}
                    margin={{
                        top: 20,
                        right: 50,
                        left: 30,
                        bottom: horizontal ? 30 : 100,
                    }}
                >
                    <CartesianGrid strokeDasharray="3 3" />
                    {horizontal ? (
                        <>
                            <XAxis
                                type="number"
                                label={
                                    xLabel
                                        ? {
                                              value: xLabel,
                                              position: 'insideBottom',
                                              offset: -15,
                                          }
                                        : undefined
                                }
                            />
                            <YAxis
                                dataKey="name"
                                type="category"
                                width={140}
                                tickFormatter={formatLabel}
                                label={
                                    yLabel
                                        ? {
                                              value: yLabel,
                                              angle: -90,
                                              position: 'insideLeft',
                                              style: { textAnchor: 'middle' },
                                          }
                                        : undefined
                                }
                            />
                        </>
                    ) : (
                        <>
                            <XAxis
                                dataKey="name"
                                tickFormatter={formatLabel}
                                angle={-45}
                                textAnchor="end"
                                interval={0}
                                height={100}
                                label={
                                    xLabel
                                        ? {
                                              value: xLabel,
                                              position: 'insideBottom',
                                              offset: -60,
                                          }
                                        : undefined
                                }
                            />
                            <YAxis
                                type="number"
                                tickFormatter={(v) => `${v}${valueSuffix}`}
                                label={
                                    yLabel
                                        ? {
                                              value: yLabel,
                                              angle: -90,
                                              position: 'insideLeft',
                                              style: { textAnchor: 'middle' },
                                          }
                                        : undefined
                                }
                            />
                        </>
                    )}
                    <Tooltip
                        labelFormatter={(label) => formatLabel(String(label))}
                        formatter={formatValue}
                    />
                    {keys.length > 1 && (
                        <Legend wrapperStyle={{ paddingTop: 20 }} />
                    )}
                    {keys.map((key, i) => (
                        <Bar
                            key={key}
                            dataKey={key}
                            name={labels[i] ?? key}
                            fill={PIE_COLORS[i % PIE_COLORS.length]}
                            stackId={stacked ? 'stack' : undefined}
                            isAnimationActive={false}
                        >
                            {!stacked &&
                                data.map((_, j) => (
                                    <Cell
                                        key={j}
                                        fill={PIE_COLORS[j % PIE_COLORS.length]}
                                    />
                                ))}
                            {!stacked && (
                                <LabelList
                                    dataKey={key}
                                    position={horizontal ? 'right' : 'top'}
                                    offset={8}
                                    style={{ fontSize: 12 }}
                                    formatter={formatValue}
                                />
                            )}
                        </Bar>
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
