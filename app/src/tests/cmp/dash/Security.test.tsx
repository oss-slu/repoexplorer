import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Security from '../../../cmp/dash/Security';

vi.mock('../../../cmp/charts/DataTable', () => ({
    default: ({
        title,
        endpoint,
        maxRows,
        scrollable,
    }: {
        title?: string;
        endpoint?: string;
        maxRows?: number;
        scrollable?: boolean;
    }) => (
        <div
            data-testid="scorecard-table"
            data-endpoint={endpoint}
            data-max-rows={maxRows}
            data-scrollable={String(scrollable)}
        >
            {title}
        </div>
    ),
}));

vi.mock('../../../cmp/charts/HeatmapTable', () => ({
    default: ({ title, endpoint }: { title?: string; endpoint?: string }) => (
        <div data-testid="security-heatmap" data-endpoint={endpoint}>
            {title}
        </div>
    ),
}));

describe('Security', () => {
    it('renders the security dashboard', async () => {
        render(<Security filters={{}} />);

        expect(
            screen.getByText(
                'Security scorecard by repository (OpenSSF Scorecard)',
            ),
        ).toBeInTheDocument();

        expect(
            screen.getByText('Average score per Security Metric'),
        ).toBeInTheDocument();
    });
});

it('passes the correct configuration to each chart', () => {
    render(<Security filters={{}} />);

    expect(screen.getByTestId('scorecard-table')).toHaveAttribute(
        'data-endpoint',
        'security/securityScorecardByRepo',
    );

    expect(screen.getByTestId('scorecard-table')).toHaveAttribute(
        'data-scrollable',
        'true',
    );

    expect(screen.getByTestId('scorecard-table')).not.toHaveAttribute(
        'data-max-rows',
    );

    expect(screen.getByTestId('security-heatmap')).toHaveAttribute(
        'data-endpoint',
        'security/avgScorePerMetric',
    );
});
