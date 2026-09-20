/**
 * Shared secret for POST /api/v2/execute.
 * You invent RUNNER_TOKEN; Algora must send the same string as Authorization
 * Same value as Algora EXECUTOR_TOKEN (Authorization header).
 */
export function assertBearer(headerValue: string | undefined, expected: string): boolean {
  if (!expected) return false;
  const got = headerValue?.trim() ?? "";
  return got === expected;
}
