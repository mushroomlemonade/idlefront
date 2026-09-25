/** Diagnostic-only state: never used for game decisions or deterministic RNG. */
export function createRateLimitedDiagnostic(
  emit: (message: string) => void,
  now: () => number = Date.now,
  intervalMs = 10_000,
) {
  const buckets = new Map<string, { last: number; suppressed: number }>();
  return (message: string): void => {
    const time = now();
    const bucket = buckets.get(message);
    if (bucket && time - bucket.last < intervalMs && time >= bucket.last) {
      bucket.suppressed++;
      return;
    }
    // Call sites must use fixed messages, never per-unit IDs. Bound this anyway.
    if (!bucket && buckets.size >= 32)
      buckets.delete(buckets.keys().next().value!);
    emit(
      bucket?.suppressed
        ? `${message} (${bucket.suppressed} repeats suppressed)`
        : message,
    );
    buckets.set(message, { last: time, suppressed: 0 });
  };
}

export const routeDiagnostic = createRateLimitedDiagnostic((message) =>
  console.warn(message),
);
