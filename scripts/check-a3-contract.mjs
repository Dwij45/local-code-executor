/**
 * A3: POST success + runtime-error bodies and check fields Algora's mapPiston reads.
 * Usage: npm run check:a3
 * Env: HOST, PORT, RUNNER_TOKEN (defaults match .env.example).
 */
const host = process.env.HOST?.trim() || "127.0.0.1";
const token = process.env.RUNNER_TOKEN?.trim() || "dev-secret";
const ports = [...new Set([process.env.PORT?.trim(), "2000", "2001"].filter(Boolean))];

async function findBase() {
  for (const port of ports) {
    const base = `http://${host}:${port}`;
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (health.ok) return base;
    } catch {
      /* try next */
    }
  }
  return null;
}

const base = await findBase();
if (!base) {
  console.error("No runner on ports", ports.join(", "), "— start with npm run start");
  process.exit(1);
}
console.log("Using", base);

async function execute(body) {
  const res = await fetch(`${base}/api/v2/execute`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

function asRecord(value) {
  if (typeof value === "object" && value !== null) return value;
  return null;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const ok = await execute({
  language: "python",
  version: "*",
  files: [{ name: "main.py", content: "print(2 + 2)" }],
  stdin: "",
  run_timeout: 3000,
});
if (ok.status !== 200) fail(`success case HTTP ${ok.status}: ${JSON.stringify(ok.json)}`);
const okRun = asRecord(ok.json.run);
if (!okRun) fail("success case missing run object");
if (ok.json.compile) fail("Python must not send a compile object");
if (Number(okRun.code) !== 0) fail(`expected code 0, got ${okRun.code}`);
if (typeof okRun.stdout !== "string" || !okRun.stdout.includes("4")) {
  fail(`expected stdout to contain 4, got ${JSON.stringify(okRun.stdout)}`);
}
if (okRun.signal != null) fail(`expected signal null, got ${okRun.signal}`);

const err = await execute({
  language: "python",
  version: "*",
  files: [{ name: "main.py", content: "print(1/0)" }],
  stdin: "",
  run_timeout: 3000,
});
if (err.status !== 200) fail(`error case HTTP ${err.status}: ${JSON.stringify(err.json)}`);
const errRun = asRecord(err.json.run);
if (!errRun) fail("error case missing run object");
if (Number(errRun.code) === 0) fail("division by zero should be non-zero run.code (Algora RE)");
if (typeof errRun.stderr !== "string" || !errRun.stderr.includes("ZeroDivisionError")) {
  fail(`expected ZeroDivisionError on stderr, got ${JSON.stringify(errRun.stderr)}`);
}

console.log("A3 contract ok");
console.log("  AC sample:", { code: okRun.code, stdout: JSON.stringify(okRun.stdout) });
console.log("  RE sample:", { code: errRun.code, stderrPreview: errRun.stderr.slice(0, 80) });
