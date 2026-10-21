import { useState } from 'react';
import DataTable from '../charts/DataTable';
import NavBar from '../NavBar';
import Markdown from 'react-markdown';
import { MAX_VISIBLE_ROWS } from '../../consts';

export default function Browse() {
    const [selectedRow, setSelectedRow] = useState<Record<
        string,
        unknown
    > | null>(null);
    const [leftTab, setLeftTab] = useState('Overview');
    const [rightTab, setRightTab] = useState('README');

    // Helper to grab the correct markdown text based on the active tab
    const getMarkdownContent = () => {
        if (!selectedRow) return '';
        if (rightTab === 'README')
            return String(selectedRow.readme || 'No README file available');
        if (rightTab === 'Contributing')
            return String(
                selectedRow.contributing ||
                    'No contributing guidelines available',
            );
        if (rightTab === 'Security Policy')
            return String(
                selectedRow.securityPolicy || 'No security policy available',
            );
        return '';
    };

    return (
        <div className="dashboard">
            <div
                className="dashboard-top-row"
                style={{ gridTemplateColumns: '1fr' }}
            >
                <DataTable
                    title="Browse Repositories"
                    endpoint="overview/repositories"
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
                        display: 'grid',
                        gridTemplateColumns: '1fr 2fr',
                        gap: '32px',
                    }}
                >
                    {/* Left Column */}
                    <div>
                        <NavBar
                            items={['Overview', 'Impact', 'Health', 'Security']}
                            active={leftTab}
                            onChange={setLeftTab}
                            type="tabs"
                        />
                        <div className="tab-view" style={{ marginTop: '16px' }}>
                            {leftTab === 'Overview' && (
                                <div
                                    style={{
                                        fontSize: '15px',
                                        color: '#333',
                                        lineHeight: '2',
                                    }}
                                >
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            Name:
                                        </strong>{' '}
                                        {String(
                                            selectedRow.fullName ||
                                                selectedRow.name ||
                                                'N/A',
                                        )}
                                    </p>
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            University:
                                        </strong>{' '}
                                        {String(
                                            selectedRow.university || 'N/A',
                                        )}
                                    </p>
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            License:
                                        </strong>{' '}
                                        {String(selectedRow.license || 'N/A')}
                                    </p>
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            Language:
                                        </strong>{' '}
                                        {String(selectedRow.language || 'N/A')}
                                    </p>
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            Project Type:
                                        </strong>{' '}
                                        {String(
                                            selectedRow.typePredictionGpt5Mini ||
                                                'N/A',
                                        )}
                                    </p>
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            Description:
                                        </strong>{' '}
                                        {String(
                                            selectedRow.description || 'N/A',
                                        )}
                                    </p>
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            URL:
                                        </strong>{' '}
                                        <a
                                            href={String(
                                                selectedRow.url || '#',
                                            )}
                                            target="_blank"
                                            rel="noreferrer"
                                            style={{ color: '#3b71ca' }}
                                        >
                                            {String(selectedRow.url || 'N/A')}
                                        </a>
                                    </p>
                                </div>
                            )}

                            {leftTab === 'Impact' && (
                                <table
                                    style={{
                                        width: '100%',
                                        fontSize: '15px',
                                        textAlign: 'left',
                                        borderCollapse: 'collapse',
                                    }}
                                >
                                    <thead>
                                        <tr
                                            style={{
                                                borderBottom: '1px solid #ddd',
                                            }}
                                        >
                                            <th style={{ padding: '8px 0' }}>
                                                Metric
                                            </th>
                                            <th
                                                style={{
                                                    padding: '8px 0',
                                                    textAlign: 'right',
                                                }}
                                            >
                                                Value
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr>
                                            <td
                                                style={{
                                                    color: '#3b71ca',
                                                    fontWeight: 'bold',
                                                    padding: '8px 0',
                                                }}
                                            >
                                                Number of stars
                                            </td>
                                            <td style={{ textAlign: 'right' }}>
                                                {String(
                                                    selectedRow.stargazersCount ||
                                                        0,
                                                )}
                                            </td>
                                        </tr>
                                        <tr>
                                            <td
                                                style={{
                                                    color: '#3b71ca',
                                                    fontWeight: 'bold',
                                                    padding: '8px 0',
                                                }}
                                            >
                                                Number of forks
                                            </td>
                                            <td style={{ textAlign: 'right' }}>
                                                {String(
                                                    selectedRow.forksCount || 0,
                                                )}
                                            </td>
                                        </tr>
                                        <tr>
                                            <td
                                                style={{
                                                    color: '#3b71ca',
                                                    fontWeight: 'bold',
                                                    padding: '8px 0',
                                                }}
                                            >
                                                Number of issues
                                            </td>
                                            <td style={{ textAlign: 'right' }}>
                                                {String(
                                                    selectedRow.openIssuesCount ||
                                                        0,
                                                )}
                                            </td>
                                        </tr>
                                        <tr>
                                            <td
                                                style={{
                                                    color: '#3b71ca',
                                                    fontWeight: 'bold',
                                                    padding: '8px 0',
                                                }}
                                            >
                                                Number of contributors
                                            </td>
                                            <td style={{ textAlign: 'right' }}>
                                                {String(
                                                    selectedRow.contributorCount ||
                                                        0,
                                                )}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            )}

                            {leftTab === 'Health' && (
                                <table
                                    style={{
                                        width: '100%',
                                        fontSize: '15px',
                                        textAlign: 'left',
                                        borderCollapse: 'collapse',
                                    }}
                                >
                                    <thead>
                                        <tr
                                            style={{
                                                borderBottom: '1px solid #ddd',
                                            }}
                                        >
                                            <th style={{ padding: '8px 0' }}>
                                                Health check
                                            </th>
                                            <th
                                                style={{
                                                    padding: '8px 0',
                                                    textAlign: 'right',
                                                }}
                                            >
                                                Present
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {[
                                            {
                                                label: 'Description',
                                                val: selectedRow.description,
                                            },
                                            {
                                                label: 'README',
                                                val: selectedRow.readme,
                                            },
                                            {
                                                label: 'Contributing guide',
                                                val: selectedRow.contributing,
                                            },
                                            {
                                                label: 'Code of conduct',
                                                val: selectedRow.codeOfConductFile,
                                            },
                                            {
                                                label: 'Security policy',
                                                val: selectedRow.securityPolicy,
                                            },
                                            {
                                                label: 'Issue templates',
                                                val: selectedRow.issueTemplates,
                                            },
                                            {
                                                label: 'PR template',
                                                val: selectedRow.pullRequestTemplate,
                                            },
                                        ].map((item, idx) => (
                                            <tr key={idx}>
                                                <td
                                                    style={{
                                                        color: '#3b71ca',
                                                        fontWeight: 'bold',
                                                        padding: '8px 0',
                                                    }}
                                                >
                                                    {item.label}
                                                </td>
                                                <td
                                                    style={{
                                                        textAlign: 'right',
                                                        color: item.val
                                                            ? '#28a745'
                                                            : '#333',
                                                    }}
                                                >
                                                    {item.val ? '✅' : 'X'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}

                            {leftTab === 'Security' && (
                                <div
                                    style={{
                                        fontSize: '15px',
                                        color: '#333',
                                        lineHeight: '2',
                                    }}
                                >
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            URL Exists:
                                        </strong>{' '}
                                        {selectedRow.url ? 'Yes' : 'No'}
                                    </p>
                                    <p>
                                        <strong style={{ color: '#3b71ca' }}>
                                            Email Exists:
                                        </strong>{' '}
                                        {selectedRow.email ? 'Yes' : 'No'}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Right Column */}
                    <div
                        style={{
                            border: '1px solid #eee',
                            borderRadius: '4px',
                            backgroundColor: '#fff',
                        }}
                    >
                        <NavBar
                            items={[
                                'README',
                                'Contributing',
                                'Security Policy',
                            ]}
                            active={rightTab}
                            onChange={setRightTab}
                            type="tabs"
                        />
                        <div className="tab-view" style={{ padding: '24px' }}>
                            <div
                                style={{
                                    maxHeight: '400px',
                                    overflowY: 'auto',
                                }}
                            >
                                <Markdown>{getMarkdownContent()}</Markdown>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
