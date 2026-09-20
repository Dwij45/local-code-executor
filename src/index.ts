import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleExecute } from "./execute-handler.js";
import { ENABLED_LANGUAGES } from "./runtimes.js";
import { newJobId, trace } from "./trace.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}. Copy .env.example to .env`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const token = requiredEnv("RUNNER_TOKEN");
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = numberEnv("PORT", 2000);
const maxSourceChars = numberEnv("MAX_SOURCE_CHARS", 10_000);
const maxRunTimeoutMs = numberEnv("MAX_RUN_TIMEOUT_MS", 10_000); // Java: cold JVM often needs more than 3s
const maxCompileTimeoutMs = numberEnv("MAX_COMPILE_TIMEOUT_MS", 10_000); // C++ / Java: g++ / javac cap
const maxStdoutBytes = numberEnv("MAX_STDOUT_BYTES", 65_536);

const app = new Hono();

app.get("/health", (c) =>
  c.json({ ok: true, languages: ENABLED_LANGUAGES, isolation: true }),
);

app.post("/api/v2/execute", async (c) => {
  const jobId = newJobId();
  trace(jobId, "index.ts POST /api/v2/execute");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    trace(jobId, "invalid JSON body");
    return c.json({ message: "Invalid JSON body." }, 400);
  }
  const result = await handleExecute({
    jobId,
    authorization: c.req.header("Authorization"),
    body: json,
    token,
    maxSourceChars,
    maxRunTimeoutMs,
    maxCompileTimeoutMs,
    maxStdoutBytes,
  });
  trace(jobId, "index.ts response", { status: result.status });
  return c.json(result.body, result.status as 200 | 400 | 401 | 502);
});

/** Bind PORT, then PORT+1, … if that address is already taken (EADDRINUSE). */
function listenPreferPort(preferred: number, extraTries = 20): void {
  const tryPort = (candidate: number): void => {
    const server = serve({ fetch: app.fetch, hostname: host, port: candidate }, (info) => {
      console.log(`algora-runner listening on http://${info.address}:${info.port}`);
      console.log("POST /api/v2/execute (python, javascript, c++, java, isolation). Bind is loopback.");
    });
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && candidate < preferred + extraTries) {
        console.warn(`Port ${candidate} in use, trying ${candidate + 1}`);
        tryPort(candidate + 1);
        return;
      }
      throw err;
    });
  };
  tryPort(preferred);
}

listenPreferPort(port);
