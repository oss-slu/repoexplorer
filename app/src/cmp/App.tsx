import PieChartDiv from './charts/PieChartDiv';

function App() {
    return (
        <>
            <main style={{ textAlign: 'center' }}>
                <h1>OSS Open Source Repository Browser</h1>
                <PieChartDiv
                    title="Language Distribution"
                    endpoint="overview/languageDistribution"
                />
                <PieChartDiv
                    title="Project Type Distribution"
                    endpoint="overview/typeDistribution"
                />
                <PieChartDiv
                    title="License Distribution"
                    endpoint="overview/licenseDistribution"
                />
                <BarChartDiv
                    title="Community Files Presence"
                    endpoint="overview/communityFilesPresence"
                />
                <BarChartDiv
                    title="Language Distribution by Type"
                    endpoint="overview/languageDistributionByType"
                    stacked
                />
                <BarChartDiv
                    title="License Distribution by Type"
                    endpoint="overview/licenseDistributionByType"
                    stacked
                />
            </main>
        </>
    );
}

export default App;
