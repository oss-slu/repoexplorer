export async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T, index: number) => Promise<R>,
    onFatalError?: (error: unknown, index: number) => void,
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
                        onFatalError?.(error, index);
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

export async function allOrThrow<T extends readonly unknown[]>(
    promises: {
        [Index in keyof T]: Promise<T[Index]>;
    },
    onFatalError?: (error: unknown) => void,
): Promise<T> {
    let firstError: unknown;
    let hasError = false;
    const guarded = promises.map((promise) =>
        Promise.resolve(promise).catch((error: unknown) => {
            if (!hasError) {
                firstError = error;
                hasError = true;
                onFatalError?.(error);
            }
            throw error;
        }),
    );
    const settled = await Promise.allSettled(guarded);
    if (hasError) throw firstError;
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
