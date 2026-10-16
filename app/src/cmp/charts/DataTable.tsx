import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { chartProps } from '../../types/charts';
import { formatLabel } from '../../utils/formatLabel';

export default function DataTable({
    title,
    endpoint,
    maxRows,
    scrollable = false,
    filters = {},
}: chartProps & {
    scrollable?: boolean;
    filters?: Record<string, string | number>;
}) {
    const [data, setData] = useState<Record<string, unknown>[]>([]);
    const [loading, setLoading] = useState<boolean>(Boolean(endpoint));
    const [error, setError] = useState<string>('');

    const queryString = new URLSearchParams(
        Object.entries(filters)
            .filter(([, value]) => value !== 'All' && value !== '')
            .map(([key, value]) => [key, String(value)]),
    ).toString();

    useEffect(() => {
        if (!endpoint) {
            return;
        }

        const controller = new AbortController();

        const fetchData = async () => {
            try {
                setLoading(true);
                setError('');

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

                const arr: Record<string, unknown>[] = Array.isArray(json)
                    ? json
                    : (Object.values(json)[0] as Record<string, unknown>[]);

                setData(arr);
            } catch (err) {
                if (controller.signal.aborted) {
                    return;
                }

                console.error(err);
                setError(
                    err instanceof Error ? err.message : 'Failed to load data',
                );
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            }
        };

        void fetchData();

        return () => controller.abort();
    }, [endpoint, queryString]);

    if (loading) {
        return <div>Loading {title}...</div>;
    }

    if (error) {
        return (
            <div>
                Failed to load {title}: {error}
            </div>
        );
    }

    // Get column names from first row
    let headers: string[] = [];
    if (data && data.length > 0) {
        headers = Object.keys(data[0]);
    }

    return (
        <div style={{ width: '100%', overflowX: 'auto', marginBottom: '24px' }}>
            <h2 style={{ textAlign: 'left' }}>{title}</h2>

            {data.length === 0 ? (
                <p>No data available</p>
            ) : (
                <div
                    style={{
                        maxHeight: scrollable ? '480px' : undefined,
                        overflowY: scrollable ? 'auto' : undefined,
                        overflowX: 'auto',
                    }}
                >
                    <table
                        style={{
                            width: '100%',
                            minWidth: 'max-content',
                            borderCollapse: 'collapse',
                        }}
                    >
                        <thead>
                            <tr
                                style={{
                                    borderBottom: '2px solid #ddd',
                                    textAlign: 'left',
                                }}
                            >
                                {headers.map((header) => (
                                    <th
                                        key={header}
                                        style={{ padding: '12px 8px' }}
                                    >
                                        {header === 'name'
                                            ? 'University'
                                            : header === 'value'
                                              ? 'Count'
                                              : formatLabel(header)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {data
                                .slice(0, maxRows ?? data.length)
                                .map((row, index) => (
                                    <tr
                                        key={index}
                                        style={{
                                            borderBottom: '1px solid #eee',
                                        }}
                                    >
                                        {headers.map((header) => (
                                            <td
                                                key={header}
                                                style={{
                                                    padding: '12px 8px',
                                                }}
                                            >
                                                {typeof row[header] === 'number'
                                                    ? Number(
                                                          row[header].toFixed(
                                                              2,
                                                          ),
                                                      ).toString()
                                                    : String(row[header] ?? '')}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
