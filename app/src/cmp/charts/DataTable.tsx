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
    showSearch = false,
    showRowMessage = true,
    showDownload = false,
    onRowClick,
}: chartProps & {
    scrollable?: boolean;
    filters?: Record<string, string[] | number>;
    showSearch?: boolean;
    showRowMessage?: boolean;
    showDownload?: boolean;
    onRowClick?: (row: Record<string, unknown>) => void;
}) {
    const [data, setData] = useState<Record<string, unknown>[]>([]);
    const [loading, setLoading] = useState<boolean>(Boolean(endpoint));
    const [error, setError] = useState<string>('');
    const [searchQuery, setSearchQuery] = useState<string>('');
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
        if (!endpoint) {
            return;
        }

        const controller = new AbortController();

        const fetchData = async () => {
            try {
                setLoading(true);
                setError('');

                const url = `${API_URL}/${endpoint}${
                    queryParams ? `?${queryParams}` : ''
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
    }, [endpoint, queryParams]);

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

    // Filter data based on search query
    const filteredData = data.filter((row) => {
        if (!searchQuery) return true;
        
        // Check if any value in the row matches the search string (case-insensitive)
        return Object.values(row).some((val) => 
            String(val).toLowerCase().includes(searchQuery.toLowerCase())
        );
    });

    const handleDownload = () => {
        if (filteredData.length === 0) return;
        
        const keys = Object.keys(filteredData[0]);
        const csvContent = [
            keys.join(','),
            ...filteredData.map((row) =>
                keys.map((k) => `"${String(row[k] ?? '')}"`).join(',')
            ),
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', `${String(title).replace(/\s+/g, '_')}_data.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <div style={{ width: '100%', overflowX: 'auto', marginBottom: '24px' }}>
            <h2 style={{ textAlign: 'left' }}>{title}</h2>

            {showSearch && (
                <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>Search</label>
                    <input
                        type="text"
                        placeholder="Search table..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{
                            padding: '8px',
                            width: '100%',
                            borderRadius: '4px',
                            border: '1px solid #ccc',
                            boxSizing: 'border-box'
                        }}
                    />
                </div>
            )}

            {filteredData.length === 0 ? (
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
                            {filteredData
                                .slice(0, maxRows ?? filteredData.length)
                                .map((row, index) => (
                                    <tr
                                        key={index}
                                        onClick={() => onRowClick && onRowClick(row)}
                                        style={{
                                            borderBottom: '1px solid #eee',
                                            cursor: onRowClick ? 'pointer' : 'default',
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
                                                          row[header].toFixed(2),
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

            {showRowMessage && (
                <p style={{ marginTop: '16px', fontSize: '14px', color: '#333' }}>
                    Viewing rows {filteredData.length > 0 ? 1 : 0} through {Math.min(maxRows ?? filteredData.length, filteredData.length)} of {filteredData.length}
                </p>
            )}

            {showDownload && (
                <button
                    onClick={handleDownload}
                    style={{
                        marginTop: '8px',
                        padding: '8px',
                        width: '100%',
                        backgroundColor: '#f1f1f1',
                        border: '1px solid #ccc',
                        borderRadius: '4px',
                        cursor: 'pointer'
                    }}
                >
                    Download
                </button>
            )}
        </div>
    );
}