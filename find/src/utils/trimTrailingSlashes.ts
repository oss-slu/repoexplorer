/** Trim URL path separators in one backwards pass, without regex backtracking. */
export function trimTrailingSlashes(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') end -= 1;
    return value.slice(0, end);
}
