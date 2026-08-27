/**
 * Runs `worker` over `items` with a bounded number of in-flight calls, keeping
 * the result in input order.
 *
 * Deliberately lives in `@pr-atlas/connectors` rather than `@pr-atlas/core`:
 * connectors depend only on `@pr-atlas/schema`, and keeping that dependency edge
 * intact is worth more than sharing a helper this small.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const queue = items.map((item, index) => ({ item, index }))
  const results = new Array<R>(items.length)
  const workers = Math.max(1, Math.min(limit, queue.length))
  let cursor = 0

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        // Reason: JS runs this read-and-increment without interleaving, so the
        // shared cursor needs no lock.
        const job = queue[cursor++]
        if (!job) return
        results[job.index] = await worker(job.item, job.index)
      }
    }),
  )

  return results
}
