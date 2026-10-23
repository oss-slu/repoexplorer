
import { useState } from 'react';
import DataTable from '../charts/DataTable';
import { MAX_VISIBLE_ROWS } from '../../consts';

export default function BrowseOrgs({
    filters = {},
}: {
    filters?: Record<string, string[] | number>;
}) {

    const [selectedRow, setSelectedRow] = useState<Record<
        string,
        unknown
    > | null>(null);

    return (
        <div className="dashboard">
            <div
                className="dashboard-top-row"
                style={{ gridTemplateColumns: '1fr' }}
            >
                <DataTable
                    title="Browse Organizations"
                    endpoint="organization/organizations"
                    filters={filters}
                    showSearch
                    showRowMessage
                    showDownload
                    scrollable
                    maxRows={MAX_VISIBLE_ROWS}
                    onRowClick={(row) => setSelectedRow(row)}
                />
            </div>

            {selectedRow && (
                <div
                    style={{
                        marginTop: '32px',
                        paddingTop: '24px',
                        borderTop: '2px solid #ddd',
                    }}
                >
                    <h3>Organization Details</h3>

                    <div
                        style={{
                            fontSize: '15px',
                            color: '#333',
                            lineHeight: '2',
                        }}
                    >
                        <p>
                            <strong>Organization: </strong>
                            {String(
                                selectedRow.name ||
                                    selectedRow.login ||
                                    'N/A',
                            )}
                        </p>

                        <p>
                            <strong>University: </strong>
                            {String(selectedRow.university || 'N/A')}
                        </p>

                        <p>
                            <strong>URL Exists: </strong>
                            {selectedRow.url ? 'Yes' : 'No'}
                        </p>

                        <p>
                            <strong>Description Exists: </strong>
                            {selectedRow.description ? 'Yes' : 'No'}
                        </p>

                        <p>
                            <strong>Email Exists: </strong>
                            {selectedRow.email ? 'Yes' : 'No'}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
