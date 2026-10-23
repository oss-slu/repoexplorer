export async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError('concurrency must be a positive integer');
    }
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    let firstError: unknown;
    let hasError = false;
    const workerCount = Math.min(concurrency, values.length);
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                if (hasError) {
                    return;
                }
                const index = nextIndex;
                nextIndex += 1;
                if (index >= values.length) {
                    return;
                }
                try {
                    results[index] = await map(values[index], index);
                } catch (error) {
                    if (!hasError) {
                        firstError = error;
                        hasError = true;
                    }
                    return;
                }
            }
        }),
    );
    if (hasError) {
        throw firstError;
    }
    return results;
}

export async function allOrThrow<T extends readonly unknown[]>(promises: {
    [Index in keyof T]: Promise<T[Index]>;
}): Promise<T> {
    const settled = await Promise.allSettled(promises);
    const failure = settled.find(
        (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
    );
    if (failure) {
        throw failure.reason;
    }
    return settled.map(
        (result) => (result as PromiseFulfilledResult<unknown>).value,
    ) as unknown as T;
}
