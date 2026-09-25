/** One-line execute traces. Source is previewed, never the auth token. */

export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function preview(text: string, maxChars = 160): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length <= maxChars) return JSON.stringify(normalized);
  return JSON.stringify(`${normalized.slice(0, maxChars)}…`);
}

export function trace(jobId: string, step: string, detail?: Record<string, unknown>): void {
  const extra = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  console.log(`[${jobId}] ${step}${extra}`);
}
