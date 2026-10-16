import { useState } from 'react';
import NavBar from './NavBar';
import Overview from './dash/Overview';
import Security from './dash/Security';
import Sustainability from './dash/Sustainability';
import Organization from './dash/Organization';
import Impact from './dash/Impact';
import aboutText from '../../../docs/about.md?raw';
import Markdown from 'react-markdown';
import SidebarFilters from './SidebarFilters';

const MAIN_PAGES = ['About', 'Repositories', 'Organizations'];
const REPO_TABS = [
    'Overview',
    'Browse',
    'Impact',
    'Sustainability',
    'Security',
];
const ORG_TABS = ['Overview', 'Browse'];

const REPO_FILTERS = [
    {
        key: 'university',
        label: 'University',
        type: 'text' as const,
        options: [
            'All',
            'Saint Louis University',
            'University of California, Santa Cruz',
            'University of California, Santa Barbara',
        ],
        defaultValue: 'All',
    },
    {
        key: 'typePredictionGpt5Mini',
        label: 'Project Type',
        type: 'text' as const,
        options: ['All', 'DEV', 'EDU', 'WEB', 'DOCS'],
        defaultValue: 'All',
    },
    {
        key: 'license',
        label: 'License',
        type: 'text' as const,
        options: [
            'All',
            'mit',
            'apache-2.0',
            'gpl-3.0',
            'bsd-3-clause',
            'cc-by-sa-4.0',
        ],
        defaultValue: 'All',
    },
    {
        key: 'language',
        label: 'Primary Language',
        type: 'text' as const,
        options: ['All', 'TypeScript', 'JavaScript', 'Python', 'C++'],
        defaultValue: 'All',
    },
    {
        key: 'affiliationPredictionGpt5Mini',
        label: 'Minimum Prediction Score',
        type: 'slider' as const,
        min: 0,
        max: 1,
        defaultValue: 0,
    },
    {
        key: 'stargazersCount',
        label: 'Minimum Stars',
        type: 'slider' as const,
        min: 0,
        max: 500,
        defaultValue: 0,
    },
    {
        key: 'forksCount',
        label: 'Minimum Forks',
        type: 'slider' as const,
        min: 0,
        max: 500,
        defaultValue: 0,
    },
    {
        key: 'releaseDownloads',
        label: 'Minimum Release Downloads',
        type: 'slider' as const,
        min: 0,
        max: 500,
        defaultValue: 0,
    },
];

const ORG_FILTERS = [
    {
        key: 'university',
        label: 'University',
        type: 'text' as const,
        options: ['All', 'GWU'],
        defaultValue: 'All',
    },
    {
        key: 'affiliationPredictionOrgs',
        label: 'Prediction Threshold',
        type: 'slider' as const,
        min: 0,
        max: 1,
        defaultValue: 0,
    },
];

const getDefaultValues = (
    filters: typeof REPO_FILTERS | typeof ORG_FILTERS,
) => {
    const defaults: Record<string, string | number> = {};

    filters.forEach((filter) => {
        defaults[filter.key] = filter.defaultValue;
    });

    return defaults;
};

function App() {
    const [page, setPage] = useState('Repositories');
    const [repoTab, setRepoTab] = useState('Overview');
    const [orgTab, setOrgTab] = useState('Overview');
    const [filtersOpen, setFiltersOpen] = useState(true);

    const [repoFilterValues, setRepoFilterValues] = useState<
        Record<string, string | number>
    >(() => getDefaultValues(REPO_FILTERS));

    const [orgFilterValues, setOrgFilterValues] = useState<
        Record<string, string | number>
    >(() => getDefaultValues(ORG_FILTERS));

    return (
        <main className="container">
            {/* 1. Page title */}
            <h1>Open Source Repository Browser</h1>

            {/* 2. Navigation bar */}
            <NavBar
                items={MAIN_PAGES}
                active={page}
                onChange={setPage}
                type="pills"
            />

            {/* 3. Content container */}
            <div className="content">
                {page === 'About' && (
                    <div className="about-box">
                        <Markdown>{aboutText}</Markdown>
                    </div>
                )}

                {page === 'Repositories' && (
                    <div className="page-body">
                        {/* Placeholder for Issue #22 filters sidebar */}
                        <div
                            className={`sidebar ${filtersOpen ? 'open' : 'closed'}`}
                        >
                            <button
                                onClick={() => setFiltersOpen(!filtersOpen)}
                                className="collapse-button"
                            >
                                {filtersOpen ? '<' : '>'}
                            </button>

                            {filtersOpen && (
                                <SidebarFilters
                                    filters={REPO_FILTERS}
                                    values={repoFilterValues}
                                    onChange={(key, value) =>
                                        setRepoFilterValues((previous) => ({
                                            ...previous,
                                            [key]: value,
                                        }))
                                    }
                                    onReset={() =>
                                        setRepoFilterValues(
                                            getDefaultValues(REPO_FILTERS),
                                        )
                                    }
                                />
                            )}
                        </div>

                        <div className="main-content">
                            <NavBar
                                items={REPO_TABS}
                                active={repoTab}
                                onChange={setRepoTab}
                                type="tabs"
                            />

                            <div className="tab-view">
                                {repoTab === 'Overview' && (
                                    <Overview filters={repoFilterValues} />
                                )}
                                {repoTab === 'Security' && (
                                    <Security filters={repoFilterValues} />
                                )}
                                {repoTab === 'Sustainability' && (
                                    <Sustainability
                                        filters={repoFilterValues}
                                    />
                                )}
                                {repoTab === 'Impact' && (
                                    <Impact filters={repoFilterValues} />
                                )}
                                {repoTab !== 'Overview' &&
                                    repoTab !== 'Security' &&
                                    repoTab !== 'Sustainability' &&
                                    repoTab !== 'Impact' && (
                                        <div className="tab-placeholder">
                                            <p>{repoTab} Dashboard</p>
                                        </div>
                                    )}
                            </div>
                        </div>
                    </div>
                )}

                {page === 'Organizations' && (
                    <div className="page-body">
                        <div
                            className={`sidebar ${filtersOpen ? 'open' : 'closed'}`}
                        >
                            <button
                                onClick={() => setFiltersOpen(!filtersOpen)}
                                className="collapse-button"
                            >
                                {filtersOpen ? '<' : '>'}
                            </button>

                            {filtersOpen && (
                                <SidebarFilters
                                    filters={ORG_FILTERS}
                                    values={orgFilterValues}
                                    onChange={(key, value) =>
                                        setOrgFilterValues((previous) => ({
                                            ...previous,
                                            [key]: value,
                                        }))
                                    }
                                    onReset={() =>
                                        setOrgFilterValues(
                                            getDefaultValues(ORG_FILTERS),
                                        )
                                    }
                                />
                            )}
                        </div>

                        <div className="main-content">
                            <NavBar
                                items={ORG_TABS}
                                active={orgTab}
                                onChange={setOrgTab}
                                type="tabs"
                            />

                            <div className="tab-view">
                                {orgTab === 'Overview' && (
                                    <Organization filters={orgFilterValues} />
                                )}
                                {orgTab !== 'Overview' && (
                                    <div className="tab-placeholder">
                                        <p>Organizations {orgTab} Dashboard</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </main>
    );
}

export default App;
