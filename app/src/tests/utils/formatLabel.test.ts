import { describe, expect, it } from 'vitest';
import { formatLabel } from '../../utils/formatLabel';

describe('formatLabel helper', () => {
    it('converts standard camelCase to Title Case with spaces', () => {
        expect(formatLabel('binaryArtifacts')).toBe('Binary Artifacts');
        expect(formatLabel('totalContributors')).toBe('Total Contributors');
        expect(formatLabel('percentWithLicense')).toBe('Percent With License');
    });

    it('handles single word lowercase strings', () => {
        expect(formatLabel('downloads')).toBe('Downloads');
        expect(formatLabel('stars')).toBe('Stars');
    });

    it('handles already capitalized PascalCase strings gracefully', () => {
        expect(formatLabel('TotalDownloads')).toBe('Total Downloads');
    });

    it('returns an empty string when passed an empty string', () => {
        expect(formatLabel('')).toBe('');
    });
});