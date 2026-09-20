/** One in-flight Docker job. Stops two language runtimes from stacking RAM on a laptop. */
import { trace } from "./trace.js";

let tail: Promise<void> = Promise.resolve();

export async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  trace(jobId, "job-lock waiting");
  await previous;
  trace(jobId, "job-lock acquired");
  try {
    return await fn();
  } finally {
    release();
    trace(jobId, "job-lock released");
  }
}
