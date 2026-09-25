/**
 * A5: JavaScript — stdin round-trip, runtime error, Python still works.
 * Usage: npm run check:a5
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

const py = await execute({
  language: "python",
  version: "*",
  files: [{ name: "main.py", content: "print(2 + 2)" }],
  stdin: "",
  run_timeout: 3000,
});
if (py.status !== 200) fail(`python HTTP ${py.status}: ${JSON.stringify(py.json)}`);
if (Number(asRecord(py.json.run)?.code) !== 0) fail("python should still pass");
if (!String(asRecord(py.json.run)?.stdout).includes("4")) fail("python stdout");

const js = await execute({
  language: "javascript",
  version: "*",
  files: [
    {
      name: "index.js",
      content: 'const fs = require("fs");\nprocess.stdout.write(fs.readFileSync(0, "utf8"));',
    },
  ],
  stdin: "hello\n",
  run_timeout: 3000,
});
if (js.status !== 200) fail(`js HTTP ${js.status}: ${JSON.stringify(js.json)}`);
const jsRun = asRecord(js.json.run);
if (!jsRun) fail("js missing run");
if (js.json.language !== "javascript") fail(`language ${js.json.language}`);
if (Number(jsRun.code) !== 0) fail(`js code ${jsRun.code} stderr=${jsRun.stderr}`);
if (!String(jsRun.stdout).includes("hello")) fail(`js stdout ${JSON.stringify(jsRun.stdout)}`);

const boom = await execute({
  language: "javascript",
  version: "*",
  files: [{ name: "index.js", content: 'throw new Error("boom");' }],
  stdin: "",
  run_timeout: 3000,
});
if (boom.status !== 200) fail(`boom HTTP ${boom.status}`);
const boomRun = asRecord(boom.json.run);
if (!boomRun) fail("boom missing run");
if (Number(boomRun.code) === 0) fail("throw should be non-zero");
if (!String(boomRun.stderr).includes("boom")) fail(`expected boom on stderr, got ${JSON.stringify(boomRun.stderr)}`);

const java = await execute({
  language: "java",
  version: "*",
  files: [{ name: "Main.java", content: "class Main {}" }],
  stdin: "",
});
if (java.status !== 400) fail(`java should be 400, got ${java.status}`);

const health = await fetch(`${base}/health`).then((r) => r.json());
if (!health.languages?.includes("javascript")) fail(`health languages ${JSON.stringify(health.languages)}`);

console.log("A5 javascript ok");
console.log("  python:", { code: asRecord(py.json.run)?.code });
console.log("  js stdin:", { code: jsRun.code, stdout: JSON.stringify(jsRun.stdout) });
console.log("  js throw:", { code: boomRun.code });
