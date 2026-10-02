import { useState } from 'react';
import NavBar from './NavBar';
import Overview from './dash/Overview';
import Security from './dash/Security';
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

const DEFAULT_FILTERS = [
    {
        key: 'language',
        label: 'Primary Language',
        type: 'text' as const,
        options: ['All', 'TypeScript', 'JavaScript', 'Python', 'C++'],
        defaultValue: 'All',
    },
    {
        key: 'stars',
        label: 'Minimum Stars',
        type: 'slider' as const,
        min: 0,
        max: 500,
        defaultValue: 0,
    },
];

function App() {
    const [page, setPage] = useState('Repositories');
    const [repoTab, setRepoTab] = useState('Overview');
    const [orgTab, setOrgTab] = useState('Overview');
    const [filtersOpen, setFiltersOpen] = useState(true);

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
                                <SidebarFilters filters={DEFAULT_FILTERS} />
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
                                {repoTab === 'Overview' && <Overview />}
                                {repoTab === 'Security' && <Security />}
                                {repoTab !== 'Overview' &&
                                    repoTab !== 'Security' && (
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
                                <SidebarFilters filters={DEFAULT_FILTERS} />
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
                                <div className="tab-placeholder">
                                    <p>Organizations {orgTab} Dashboard</p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </main>
    );
}

export default App;
