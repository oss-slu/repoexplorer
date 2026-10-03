import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { chartProps } from '../../types/charts';

export default function DataTable({ title, endpoint, maxRows }: chartProps) {
    const [data, setData] = useState<Record<string, unknown>[]>([]);
    const [loading, setLoading] = useState<boolean>(Boolean(endpoint));
    const [error, setError] = useState<string>('');

    useEffect(() => {
        if (!endpoint) {
            return;
        }

        (async () => {
            try {
                const resp = await fetch(`${API_URL}/${endpoint}`);

                if (!resp.ok) {
                    throw new Error(`Error fetching data: ${resp.status}`);
                }

                const json = await resp.json();
                const arr: Record<string, unknown>[] = Array.isArray(json)
                    ? json
                    : (Object.values(json)[0] as Record<string, unknown>[]);

                setData(arr);
            } catch (err) {
                console.error(err);
                setError(
                    err instanceof Error ? err.message : 'Failed to load data',
                );
            } finally {
                setLoading(false);
            }
        })();
    }, [endpoint]);

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
                <table 
                    style={{ 
                        width: '100%', 
                        minWidth: 'max-content',
                        borderCollapse: 'collapse' 
                    }}>
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
                                          : header}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {data.slice(0, maxRows ?? data.length).map((row, index) => (
                            <tr
                                key={index}
                                style={{ borderBottom: '1px solid #eee' }}
                            >
                                {headers.map((header) => (
                                    <td
                                        key={header}
                                        style={{ padding: '12px 8px' }}
                                    >
                                        {String(row[header] ?? '')}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
