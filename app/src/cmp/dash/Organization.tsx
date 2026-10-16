import { useEffect, useState } from 'react';
import { API_URL } from '../../consts';
import type { organizationSummary } from '../../types/dash';
import BarChartDiv from '../charts/BarChartDiv';
import DataBlock from '../charts/DataBlock';

type OrganizationProps = {
    filters?: Record<string, string | number>;
};

export default function Organization({ filters }: OrganizationProps) {
    const [summary, setSummary] = useState<organizationSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const queryString = new URLSearchParams(
        Object.entries(filters ?? {})
            .filter(
                ([, value]) => value !== 'All' && value !== '' && value !== 0,
            )
            .map(([key, value]) => [key, String(value)]),
    ).toString();

    useEffect(() => {
        (async () => {
            try {
                const resp = await fetch(
                    `${API_URL}/organization${queryString ? `?${queryString}` : ''}`,
                );

                if (!resp.ok) {
                    throw new Error(
                        `Error fetching organization: ${resp.status}`,
                    );
                }

                const json: organizationSummary = await resp.json();
                setSummary(json);
            } catch (err) {
                console.error(err);
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to load organization',
                );
            }
        })();
    }, [queryString]);

    if (error) {
        return <div>Failed to load organization: {error}</div>;
    }

    if (!summary) {
        return <div>Loading organization...</div>;
    }

    return (
        <div className="overview-dashboard">
            <div className="overview-top-row">
                <div className="overview-summary-grid">
                    <DataBlock
                        header="Total Organizations"
                        value={summary.totalOrganizations ?? 0}
                    />
                    <DataBlock
                        header="With URL"
                        value={`${(summary.percentOrganizationsURL ?? 0).toFixed(1)}%`}
                    />
                    <DataBlock
                        header="With Description"
                        value={`${(summary.percentOrganizationsDescription ?? 0).toFixed(1)}%`}
                    />
                    <DataBlock
                        header="With Email"
                        value={`${(summary.percentOrganizationsEmail ?? 0).toFixed(1)}%`}
                    />
                </div>
            </div>

            <BarChartDiv
                title="Organizations Per University"
                endpoint="organization/orgsPerUniversity"
                horizontal
                filters={filters}
            />
            <BarChartDiv
                title="Organizations Created Per Year"
                endpoint="organization/orgsCreatedPerYear"
                filters={filters}
            />
            <BarChartDiv
                title="Profile Completeness"
                endpoint="organization/profileCompleteness"
                horizontal
                filters={filters}
            />
        </div>
    );
}
