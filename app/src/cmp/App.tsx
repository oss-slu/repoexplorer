import { useState } from 'react';
import NavBar from './NavBar';
import Overview from './dash/Overview';
import aboutText from '../../../docs/about.md?raw';
import Markdown from 'react-markdown';

const MAIN_PAGES = ['About', 'Repositories', 'Organizations'];
const REPO_TABS = [
    'Overview',
    'Browse',
    'Impact',
    'Sustainability',
    'Security',
];
const ORG_TABS = ['Overview', 'Browse'];

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
                                <div className="filters-placeholder">
                                    <p>SidebarFilters</p>
                                </div>
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
                                {repoTab !== 'Overview' && (
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
                                <div className="filters-placeholder">
                                    <p>SidebarFilters</p>
                                </div>
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
