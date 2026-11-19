/** Runs a task once fewer than the limit are running, and resolves with its result. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A counting semaphore: at most `concurrency` tasks run at once, and the rest wait their turn in
 * the order they asked.
 *
 * @param concurrency - How many may run at once.
 * @returns The limiter, shared by every task it should bound.
 *
 * @remarks
 * A finishing task hands its slot to the next one waiting rather than freeing it, so the count
 * never dips between the two. Freed and then taken, a task arriving in that moment would find a
 * slot and start too, one more than the limit.
 */
export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < concurrency) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active -= 1;
      }
    }
  };
}
