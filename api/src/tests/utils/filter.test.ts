import { filterData } from '../../utils/filter';

describe('filterData', () => {
    const repositories = [
        { language: 'Python', stargazersCount: 50 },
        { language: 'JavaScript', stargazersCount: 150 },
        { language: 'Python', stargazersCount: 300 },
    ];

    const filterableFields = {
        language: 'exact' as const,
        stargazersCount: 'min' as const,
    };

    test('returns all repositories when no filters are applied', () => {
        const result = filterData(repositories, {}, filterableFields);

        expect(result).toHaveLength(3);
    });

    test('filters repositories by minimum stars', () => {
        const result = filterData(repositories, { stargazersCount: '100' }, filterableFields);

        expect(result).toHaveLength(2);
        expect(result.every((repo) => repo.stargazersCount >= 100)).toBe(true);
    });

    test('filters repositories by language', () => {
        const result = filterData(repositories, { language: 'Python' }, filterableFields);

        expect(result).toHaveLength(2);
    });

    test('applies multiple filters together', () => {
        const result = filterData(repositories, { language: 'Python', stargazersCount: '100' }, filterableFields);

        expect(result).toHaveLength(1);
        expect(result[0].stargazersCount).toBe(300);
    });

    test('returns no repositories for an invalid minimum', () => {
        const result = filterData(repositories, { stargazersCount: 'invalid' }, filterableFields);

        expect(result).toHaveLength(0);
    });
});
