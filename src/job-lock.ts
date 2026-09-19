/** One in-flight Docker job. Stops two Python processes from stacking RAM on a laptop. */
let tail: Promise<void> = Promise.resolve();

export async function withJobLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
