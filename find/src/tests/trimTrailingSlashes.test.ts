import { trimTrailingSlashes } from '../utils/trimTrailingSlashes';

test.each([
    ['', ''],
    ['///', ''],
    ['/api/v3///', '/api/v3'],
    ['/api//v3', '/api//v3'],
    [`/api${'/'.repeat(100_000)}v3/`, `/api${'/'.repeat(100_000)}v3`],
])('trims trailing separators while preserving the path', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
});
