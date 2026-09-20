import { assertBearer } from "./auth.js";
import type { ExecuteRequest, ExecuteResponse } from "./execute-types.js";
import { runIsolatedJob } from "./container-job.js";
import { withJobLock } from "./job-lock.js";
import { runtimeFor } from "./runtimes.js";
import { preview, trace } from "./trace.js";
import { algoraJobVerdict } from "./verdict.js";

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
  jobId: string;
  authorization: string | undefined;
  body: unknown;
  token: string;
  maxSourceChars: number;
  maxRunTimeoutMs: number;
  maxCompileTimeoutMs: number;
  maxStdoutBytes: number;
}): Promise<{ status: number; body: ExecuteResponse | { message: string } }> {
  const { jobId } = opts;
  trace(jobId, "handleExecute");

  const authOk = assertBearer(opts.authorization, opts.token);
  trace(jobId, "auth.ts assertBearer", { ok: authOk, headerPresent: Boolean(opts.authorization) });
  if (!authOk) {
    return { status: 401, body: { message: "Unauthorized" } };
  }

  const parsed = parseExecuteBody(opts.body);
  if ("error" in parsed) {
    trace(jobId, "parseExecuteBody failed", { error: parsed.error });
    return { status: 400, body: { message: parsed.error } };
  }

  trace(jobId, "parseExecuteBody ok", {
    language: parsed.language,
    fileName: parsed.files[0]?.name,
    sourceChars: parsed.files[0]?.content.length ?? 0,
    stdinChars: (parsed.stdin ?? "").length,
    sourcePreview: preview(parsed.files[0]?.content ?? ""),
    stdinPreview: preview(parsed.stdin ?? ""),
  });

  const runtime = runtimeFor(parsed.language);
  if (!runtime) {
    return {
      status: 400,
      body: { message: "language must be python, javascript, c++, or java." }, // Java: A7; C++ id is "c++" not "cpp"
    };
  }

  const version =
    !parsed.version || parsed.version === "*" ? runtime.defaultVersion : parsed.version;

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
  const compileTimeoutMs = Math.min(
    Math.max(1, parsed.compile_timeout ?? opts.maxCompileTimeoutMs),
    opts.maxCompileTimeoutMs,
  ); // C++ / Java: clamp compiler time so a compile bomb cannot run forever

  try {
    const result = await withJobLock(jobId, () =>
      runIsolatedJob({
        jobId,
        runtime,
        source,
        stdin: parsed.stdin ?? "",
        runTimeoutMs,
        compileTimeoutMs,
        maxStdoutBytes: opts.maxStdoutBytes,
      }),
    );
    trace(jobId, "response", {
      code: result.run.code,
      signal: result.run.signal,
      compileCode: result.compile?.code,
      stdoutChars: result.run.stdout.length,
      stderrChars: result.run.stderr.length,
      stdoutPreview: preview(result.run.stdout),
      algoraVerdict: algoraJobVerdict(result.run, result.compile),
    });
    const response: ExecuteResponse = {
      language: runtime.id,
      version,
      run: result.run,
    };
    if (result.compile) response.compile = result.compile; // C++ / Java: omit this key for Python/JS
    return { status: 200, body: response };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execute failed.";
    trace(jobId, "execute failed", { message });
    return { status: 502, body: { message } };
  }
}
