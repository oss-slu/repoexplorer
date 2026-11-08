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
import type { chartProps } from '../../types/charts';

const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: { cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; percent: number }) => {
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    if (percent < 0.03) return null;

    return (
        <text 
            x={x} 
            y={y} 
            fill="black" 
            textAnchor="middle" 
            dominantBaseline="central"
            fontSize={12}
            fontWeight={600}
        >
            {`${(percent * 100).toFixed(1)}%`}
        </text>
    );
};

const CustomTooltip = ({ active, payload, title }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0];
        const categoryName = title ? title.split(' ')[0] : 'Name'; 

        return (
            <div style={{ 
                backgroundColor: 'white', 
                padding: '12px', 
                border: '1px solid #e0e0e0',
                boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                borderRadius: '4px',
                fontSize: '14px'
            }}>
                <div style={{ marginBottom: '6px' }}>
                    <span style={{ color: '#888', marginRight: '8px' }}>{categoryName}</span>
                    <span style={{ color: 'black' }}>{data.name}</span>
                </div>
                {/* Only render Count if the API actually returns a raw count field in the payload */}
                {data.payload.count !== undefined && (
                    <div style={{ marginBottom: '6px' }}>
                        <span style={{ color: '#888', marginRight: '8px' }}>Count</span>
                        <span style={{ color: 'black' }}>{data.payload.count}</span>
                    </div>
                )}
                <div>
                    <span style={{ color: '#888', marginRight: '8px' }}>Share</span>
                    <span style={{ color: 'black' }}>
                        {`${((typeof data.value === 'number' ? data.value : Number(data.value ?? 0)) * 100).toFixed(1)}%`}
                    </span>
                </div>
            </div>
        );
    }
    return null;
};

export default function PieChartDiv({
    title,
    endpoint,
    filters = {},
}: chartProps & {
    filters?: Record<string, string[] | number>;
}) {
    const [data, setData] = useState<{ name: string; value: number }[] | null>(
        null,
    );
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
                const url = `${API_URL}${endpoint}${queryParams ? `?${queryParams}` : ''}`;
                const response = await fetch(url, { signal: controller.signal });
                
                if (!response.ok) {
                    throw new Error(`Request failed with status ${response.status}`);
                }

                const json = await response.json();

                if (controller.signal.aborted) {
                    return;
                }

                const arr: any[] = Array.isArray(json)
                    ? json
                    : (Object.values(json)[0] as any[]);

                const mergedMap = new Map<string, { value: number; count?: number }>();

                arr.forEach((item: any) => {
                    const cleanName = String(item.name).trim();
                    const lowerName = cleanName.toLowerCase();
                    const finalName = lowerName === 'unknown' || lowerName === 'other' ? 'Other' : cleanName;

                    const existing = mergedMap.get(finalName) || { value: 0, count: 0 };
                    
                    mergedMap.set(finalName, {
                        value: existing.value + Number(item.value),
                        count: item.count !== undefined ? (existing.count || 0) + Number(item.count) : undefined,
                    });
                });

                const normalizedArr = Array.from(mergedMap.entries()).map(([name, data]) => ({
                    name,
                    value: data.value,
                    ...(data.count !== undefined && { count: data.count }),
                }));

                const otherIndex = normalizedArr.findIndex((item) => item.name === 'Other');
                let otherValue = 0;
                let otherCount = 0;
                let hasOtherCount = false;
                
                if (otherIndex !== -1) {
                    otherValue = normalizedArr[otherIndex].value;
                    if (normalizedArr[otherIndex].count !== undefined) {
                        otherCount = normalizedArr[otherIndex].count as number;
                        hasOtherCount = true;
                    }
                    normalizedArr.splice(otherIndex, 1);
                }

                normalizedArr.sort((a, b) => b.value - a.value);

                const MAX_SLICES = 8;
                let top = normalizedArr;

                if (normalizedArr.length > MAX_SLICES) {
                    top = normalizedArr.slice(0, MAX_SLICES);
                    const rest = normalizedArr.slice(MAX_SLICES);
                    
                    otherValue += rest.reduce((sum, item) => sum + item.value, 0);
                    
                    for (const item of rest) {
                        if (item.count !== undefined) {
                            otherCount += item.count;
                            hasOtherCount = true;
                        }
                    }
                }

                if (otherValue > 0) {
                    const otherObj: any = { name: 'Other', value: otherValue };
                    if (hasOtherCount) {
                        otherObj.count = otherCount;
                    }
                    top.push(otherObj);
                }

                const withColors = top.map((d, i) => ({
                    ...d,
                    fill: PIE_COLORS[i % PIE_COLORS.length],
                }));

                setData(withColors);
                setError(null);
            } catch (err) {
                if (!controller.signal.aborted) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            }
        };

        fetchData();

        return () => controller.abort();
    }, [endpoint, queryParams, title]);

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
                <PieChart title={title}>
                    <Pie
                        data={data}
                        dataKey="value"
                        nameKey="name"
                        cx="45%"
                        cy="50%"
                        outerRadius="85%"
                        labelLine={false}
                        label={renderCustomizedLabel}
                        legendType="circle"
                        stroke="none"
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
                    />
                    <Legend
    layout="vertical"
    align="right"
    verticalAlign="middle"
    iconType="circle"
    iconSize={10}
    wrapperStyle={{
        maxHeight: '380px',
        overflowY: 'auto',
        paddingRight: '15px',
    }}
    content={() => {
        const sortedData = [...data].sort((a, b) => {
            const aIsOther = a.name.toLowerCase() === 'other';
            const bIsOther = b.name.toLowerCase() === 'other';

            if (aIsOther) return 1;
            if (bIsOther) return -1;

            return b.value - a.value;
        });

        return (
            <ul style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
            }}>
                {sortedData.map((entry) => (
                    <li
                        key={entry.name}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            marginBottom: '6px',
                            fontSize: '11px',
                            color: 'black',
                        }}
                    >
                        <span style={{
                            display: 'inline-block',
                            width: '10px',
                            height: '10px',
                            borderRadius: '50%',
                            backgroundColor: PIE_COLORS[
                                data.indexOf(entry) % PIE_COLORS.length
                            ],
                            marginRight: '8px',
                            flexShrink: 0,
                        }} />
                        {entry.name}
                    </li>
                ))}
            </ul>
        );
    }}
/>
                    <Tooltip content={<CustomTooltip title={title} />} />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}
