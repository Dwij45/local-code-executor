import { assertBearer } from "./auth.js";
import type { ExecuteRequest, ExecuteResponse } from "./execute-types.js";
import { withJobLock } from "./job-lock.js";
import { runPythonJob } from "./python-job.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseExecuteBody(json: unknown): ExecuteRequest | { error: string } {
  const row = asRecord(json);
  if (!row) return { error: "JSON object required." };

  const language = asString(row.language);
  if (!language) return { error: "language is required." };

  const filesRaw = row.files;
  if (!Array.isArray(filesRaw) || filesRaw.length !== 1) {
    return { error: "Provide exactly one file." };
  }
  const file = asRecord(filesRaw[0]);
  const name = asString(file?.name) ?? "main.py";
  const content = asString(file?.content);
  if (content === undefined) return { error: "files[0].content is required." };

  return {
    language,
    version: asString(row.version),
    files: [{ name, content }],
    stdin: asString(row.stdin) ?? "",
    compile_timeout: asNumber(row.compile_timeout),
    run_timeout: asNumber(row.run_timeout),
  };
}

export async function handleExecute(opts: {
  authorization: string | undefined;
  body: unknown;
  token: string;
  pythonImage: string;
  maxSourceChars: number;
  maxRunTimeoutMs: number;
  maxStdoutBytes: number;
}): Promise<{ status: number; body: ExecuteResponse | { message: string } }> {
  if (!assertBearer(opts.authorization, opts.token)) {
    return { status: 401, body: { message: "Unauthorized" } };
  }

  const parsed = parseExecuteBody(opts.body);
  if ("error" in parsed) {
    return { status: 400, body: { message: parsed.error } };
  }

  if (parsed.language !== "python") {
    return { status: 400, body: { message: "A2: only language=python is enabled." } };
  }

  const source = parsed.files[0]?.content ?? "";
  if (source.length > opts.maxSourceChars) {
    return {
      status: 400,
      body: { message: `Source too long (${source.length}). Max ${opts.maxSourceChars}.` },
    };
  }

  const runTimeoutMs = Math.min(
    Math.max(1, parsed.run_timeout ?? opts.maxRunTimeoutMs),
    opts.maxRunTimeoutMs,
  );

  try {
    const run = await withJobLock(() =>
      runPythonJob({
        source,
        stdin: parsed.stdin ?? "",
        runTimeoutMs,
        image: opts.pythonImage,
        maxStdoutBytes: opts.maxStdoutBytes,
      }),
    );
    const response: ExecuteResponse = {
      language: "python",
      version: "3.12.0",
      run,
    };
    return { status: 200, body: response };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execute failed.";
    return { status: 502, body: { message } };
  }
}
