import { useEffect, useRef, useState } from 'react';
import { API_URL, MAX_VISIBLE_ROWS } from '../../consts';
import type { chartProps } from '../../types/charts';
import { formatLabel } from '../../utils/formatLabel';

const REPO_PAGE_SIZE = 500;

export default function DataTable({
    title,
    endpoint,
    maxRows = MAX_VISIBLE_ROWS,
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
    const [selectedRow, setSelectedRow] = useState<Record<
        string,
        unknown
    > | null>(null);
    const [firstVisibleRow, setFirstVisibleRow] = useState(1);
    const [lastVisibleRow, setLastVisibleRow] = useState(MAX_VISIBLE_ROWS);
    const [repoOffset, setRepoOffset] = useState(0);
    const [hasMoreRepos, setHasMoreRepos] = useState(true);
    const [scrollTop, setScrollTop] = useState(0);
    const [loadingMore, setLoadingMore] = useState(false);

    const tableContainerRef = useRef<HTMLDivElement>(null);
    const loadingMoreRef = useRef(false);
    const isRepoBrowse = endpoint === 'overview/repositories';
    const isSecurityScorecard = endpoint === 'security/securityScorecardByRepo';
    const isPaginatedTable = isRepoBrowse || isSecurityScorecard;

    const COLUMN_WIDTHS: Record<string, string> = {
        name: '180px',
        university: '180px',
        id: '100px',
        fullname: '220px',
        owner: '160px',
        license: '110px',
        language: '120px',
        htmlurl: '220px',
        description: '250px',
        fork: '70px',
        createdat: '150px',
        updatedat: '150px',
        pushedat: '150px',
        homepage: '180px',
        size: '80px',
        stargazerscount: '130px',
        readme: '300px',
        value: '100px',
    };

    const queryString = new URLSearchParams();

    Object.entries(filters).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            value.forEach((selected) => queryString.append(key, selected));
        } else if (value !== 0) {
            queryString.append(key, String(value));
        }
    });
    
    const queryParams = queryString.toString();
    const requestKey = `${endpoint ?? ''}|${queryParams}`;
    const requestKeyRef = useRef(requestKey);

    const [totalRepoCount, setTotalRepoCount] = useState<number | null>(null);


    const getColumnWidth = (header: string) => {
        const key = header.replace(/[_\s-]/g, '').toLowerCase();
        return COLUMN_WIDTHS[key] ?? '150px';
    };

    useEffect(() => {
        if (!endpoint) {
            return;
        }

        if (requestKeyRef.current !== requestKey) {
            requestKeyRef.current = requestKey;

            setData([]);
            setRepoOffset(0);
            setHasMoreRepos(true);
            setScrollTop(0);

            if (tableContainerRef.current) {
                tableContainerRef.current.scrollTop = 0;
            }

            if (repoOffset !== 0) {
                return;
            }
        }

        const controller = new AbortController();
        const isFirstPage = !isPaginatedTable || repoOffset === 0;

        const fetchData = async () => {
            try {
                setError('');

                if (isFirstPage) {
                    setLoading(true);
                    setLoadingMore(false);
                    loadingMoreRef.current = false;
                } else {
                    setLoadingMore(true);
                    loadingMoreRef.current = true;
                }

                const params = new URLSearchParams(queryParams);
                if (isPaginatedTable) {
                    params.set('limit', String(REPO_PAGE_SIZE));
                    params.set('offset', String(repoOffset));
                }

                const serializedParams = params.toString();

                const url = `${API_URL}/${endpoint}${
                    serializedParams ? `?${serializedParams}` : ''
                }`;

                const pageRequest = fetch(url, {signal: controller.signal });

                const countRequest =
                    isPaginatedTable && repoOffset === 0
                        ? fetch(
                            `${API_URL}/${endpoint}/count${
                                queryParams ? `?${queryParams}` : ''
                            }`,
                            {signal: controller.signal},
                        )
                        : null;
                
                const [resp, countResp] = await Promise.all([
                    pageRequest,
                    countRequest,
                ]);

                if (!resp.ok) {
                    throw new Error(`Error fetching data: ${resp.status}`);
                }

                if (countResp) {
                    if (!countResp.ok) {
                        throw new Error(`Error fetching row count: ${countResp.status}`)
                    }

                    const countJson: { totalCount?: unknown } = await countResp.json();

                    if (
                        typeof countJson.totalCount !== 'number' ||
                        !Number.isFinite(countJson.totalCount)
                    ) {
                        throw new Error('Invalid repository count response');
                    }

                    setTotalRepoCount(countJson.totalCount);
                }

                const json = await resp.json();

                if (controller.signal.aborted) {
                    return;
                }

                const arr: Record<string, unknown>[] = Array.isArray(json)
                    ? json
                    : (Object.values(json)[0] as Record<string, unknown>[]);

                setData((currentData) =>
                    isPaginatedTable && repoOffset > 0
                    ?[...currentData, ...arr]
                    : arr,
                );

                if (isPaginatedTable) {
                    setHasMoreRepos(arr.length === REPO_PAGE_SIZE);
                }
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
                    setLoadingMore(false);
                    loadingMoreRef.current = false;
                }
            }
        };

        void fetchData();

        return () => {
            controller.abort();
            loadingMoreRef.current = false;
        }
    }, [endpoint, queryParams, isPaginatedTable, repoOffset, requestKey]);

    useEffect(() => {
        if (
            !isPaginatedTable ||
            !hasMoreRepos ||
            loading ||
            loadingMore ||
            loadingMoreRef.current
        ) {
            return;
        }

        const container = tableContainerRef.current;
        if (!container) {
            return;
        }

        const nearBottom =
            scrollTop + container.clientHeight >=
            container.scrollHeight - 200;
        
        if (nearBottom) {
            loadingMoreRef.current = true;
            setRepoOffset((currentOffset) => currentOffset + REPO_PAGE_SIZE);
        }
    }, [
        data.length,
        hasMoreRepos,
        isPaginatedTable,
        loading,
        loadingMore,
        scrollTop,
    ]);

    useEffect(() => {
        const container = tableContainerRef.current;

        if (container) {
            const rows = container.querySelectorAll('tbody tr');

            const containerTop =
                container.getBoundingClientRect().top + container.clientTop;
            const containerBottom = containerTop + container.clientHeight;

            let first = 0;
            let last = 0;

            rows.forEach((row, index) => {
                const rect = row.getBoundingClientRect();

                if (rect.bottom > containerTop && rect.top < containerBottom) {
                    if (first === 0) first = index + 1;
                    last = index + 1;
                }
            });

            setFirstVisibleRow(first);
            setLastVisibleRow(last);
        }
    }, [data, searchQuery, scrollable, maxRows]);

    if (loading && data.length === 0) {
        return <div>Loading {title}...</div>;
    }

    if (error && data.length === 0) {
        return (
            <div>
                Failed to load {title}: {error}
            </div>
        );
    }
    const REPOSITORY_COLUMNS = [
        'university',
        'id',
        'fullName',
        'owner',
        'license',
        'language',
        'htmlUrl',
        'description',
        'fork',
        'createdAt',
        'updatedAt',
        'pushedAt',
        'homepage',
        'size',
        'stargazersCount',
        'watchersCount',
        'forksCount',
        'openIssuesCount',
        'watchers',
        'organization',
        'releaseDownloads',
        'contributorCount',
        'busFactor',
        'subscribersCount',
        'affiliationPredictionGpt5Mini',
        'typePredictionGpt5Mini',
    ];

    let headers: string[] = [];

    if (data.length > 0) {
        // Only apply the special repository column sorting to the Browse Repositories table
        if (endpoint === 'overview/repositories') {
            headers = REPOSITORY_COLUMNS.filter((column) => column in data[0]);
        } else {
            headers = Object.keys(data[0]);
        }
    }

    // Filter data based on search query
    const filteredData = data.filter((row) => {
        if (!searchQuery) return true;

        // Check if any value in the row matches the search string (case-insensitive)
        return Object.values(row).some((val) =>
            String(val).toLowerCase().includes(searchQuery.toLowerCase()),
        );
    });

    const rowCount =
        isPaginatedTable && totalRepoCount !== null
            ? totalRepoCount
            : filteredData.length;

    const handleDownload = () => {
        if (filteredData.length === 0) return;

        const keys = Object.keys(filteredData[0]);
        const csvContent = [
            keys.join(','),
            ...filteredData.map((row) =>
                keys.map((k) => `"${String(row[k] ?? '')}"`).join(','),
            ),
        ].join('\n');

        const blob = new Blob([csvContent], {
            type: 'text/csv;charset=utf-8;',
        });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.setAttribute(
            'download',
            `${String(title).replace(/\s+/g, '_')}_data.csv`,
        );
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    function handleTableScroll(event: React.UIEvent<HTMLDivElement>) {
        const container = event.currentTarget;
        const rows = container.querySelectorAll('tbody tr');
        setScrollTop(container.scrollTop);

        if (rows.length === 0) {
            setFirstVisibleRow(0);
            setLastVisibleRow(0);
            return;
        }

        const containerTop =
            container.getBoundingClientRect().top + container.clientTop;

        const containerBottom = containerTop + container.clientHeight;

        let first = 0;
        let last = 0;

        rows.forEach((row, index) => {
            const rect = row.getBoundingClientRect();

            if (rect.bottom > containerTop && rect.top < containerBottom) {
                if (first === 0) first = index + 1;
                last = index + 1;
            }
        });

        setFirstVisibleRow(first);
        setLastVisibleRow(last);
    }

    return (
        <div style={{ width: '100%', overflowX: 'auto', marginBottom: '24px' }}>
            <h2 style={{ textAlign: 'left' }}>{title}</h2>

            {showSearch && (
                <div style={{ marginBottom: '16px' }}>
                    <label
                        style={{
                            display: 'block',
                            marginBottom: '4px',
                            fontWeight: 'bold',
                        }}
                    >
                        Search
                    </label>
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
                            boxSizing: 'border-box',
                        }}
                    />
                </div>
            )}

            {filteredData.length === 0 ? (
                <p>No data available</p>
            ) : (
                <div
                    ref={tableContainerRef}
                    onScroll={handleTableScroll}

                    style={{
                        height: scrollable
                            ? `${maxRows * 43 + 45}px`
                            : undefined,
                        overflowY: scrollable ? 'auto' : undefined,
                        overflowX: 'auto',
                        position: 'relative',
                    }}
                >
                    <table
                        style={{
                            width: 'max-content',
                            minWidth: '100%',
                            tableLayout: 'fixed',
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
                                        style={{
                                            padding: '12px 8px',
                                            width: getColumnWidth(header),
                                            minWidth: getColumnWidth(header),
                                            maxWidth: getColumnWidth(header),
                                            position: 'sticky',
                                            top: 0,
                                            backgroundColor: '#fff',
                                            zIndex: 2,
                                        }}
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
                            {filteredData.map((row, index) => (
                                <tr
                                    key={index}
                                    onClick={() => {
                                        if (onRowClick) {
                                            setSelectedRow(row);
                                            onRowClick(row);
                                        }
                                    }}
                                    style={{
                                        borderBottom: '1px solid #eee',
                                        cursor: onRowClick
                                            ? 'pointer'
                                            : 'default',
                                        backgroundColor:
                                            selectedRow === row
                                                ? '#e8f0fe'
                                                : 'transparent',
                                    }}
                                >
                                    {headers.map((header) => (
                                        <td
                                            key={header}
                                            style={{
                                                padding: '8px 10px',
                                                width: getColumnWidth(header),
                                                minWidth:
                                                    getColumnWidth(header),
                                                maxWidth:
                                                    getColumnWidth(header),
                                                whiteSpace: 'normal',
                                                wordBreak: 'break-word',
                                                verticalAlign: 'top',
                                                boxSizing: 'border-box',
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

            {loadingMore && <p>Loading more rows...</p>}
            {error && data.length > 0 && (
                <p>Failed to load {title}: {error}</p>
            )}

            {showRowMessage && (
                <p
                    style={{
                        marginTop: '16px',
                        fontSize: '14px',
                        color: '#333',
                    }}
                >
                    Viewing rows {filteredData.length > 0 ? firstVisibleRow : 0}{' '}
                    through {lastVisibleRow} of {rowCount}
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
                        cursor: 'pointer',
                    }}
                >
                    Download
                </button>
            )}
        </div>
    );
}
