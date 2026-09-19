/**
 * Shared secret for POST /api/v2/execute.
 * You invent RUNNER_TOKEN; Algora must send the same string as Authorization
 * (its env name there is PISTON_API_KEY — a leftover from the old client).
 */
export function assertBearer(headerValue: string | undefined, expected: string): boolean {
  if (!expected) return false;
  const got = headerValue?.trim() ?? "";
  return got === expected;
}
