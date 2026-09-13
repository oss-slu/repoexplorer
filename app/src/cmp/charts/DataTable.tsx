import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { chartProps } from '../../types/charts';

export default function DataTable({ title, endpoint }: chartProps) {
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

                const json: Record<string, unknown>[] = await resp.json();

                setData(json);
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
        <div
            style={{
                width: '75vw',
                margin: '0 auto',
                textAlign: 'center',
                border: '2px solid black',
            }}
        >
            <h2>{title}</h2>

            {data.length === 0 ? (
                <p>No data available</p>
            ) : (
                <table style={{ width: '100%', border: '1px solid black' }}>
                    <thead>
                        <tr>
                            {headers.map((header) => (
                                <th
                                    key={header}
                                    style={{ border: '1px solid black' }}
                                >
                                    {header}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {data.map((row, index) => (
                            <tr key={index}>
                                {headers.map((header) => (
                                    <td
                                        key={header}
                                        style={{ border: '1px solid black' }}
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
