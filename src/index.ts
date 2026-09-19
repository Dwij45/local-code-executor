import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleExecute } from "./execute-handler.js";

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
const pythonImage = process.env.PYTHON_IMAGE?.trim() || "python:3.12-slim";
const maxSourceChars = numberEnv("MAX_SOURCE_CHARS", 10_000);
const maxRunTimeoutMs = numberEnv("MAX_RUN_TIMEOUT_MS", 3_000);
const maxStdoutBytes = numberEnv("MAX_STDOUT_BYTES", 65_536);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, languages: ["python"] }));

app.post("/api/v2/execute", async (c) => {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ message: "Invalid JSON body." }, 400);
  }
  const result = await handleExecute({
    authorization: c.req.header("Authorization"),
    body: json,
    token,
    pythonImage,
    maxSourceChars,
    maxRunTimeoutMs,
    maxStdoutBytes,
  });
  return c.json(result.body, result.status as 200 | 400 | 401 | 502);
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`algora-runner listening on http://${info.address}:${info.port}`);
  console.log("POST /api/v2/execute (python only). Bind is loopback — not the public internet.");
});
