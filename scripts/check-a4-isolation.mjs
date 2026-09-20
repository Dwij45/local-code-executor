/**
 * A4: isolation — hello still works; TLE; no outbound net; output capped.
 * Usage: npm run check:a4   (runner must be up)
 */
const host = process.env.HOST?.trim() || "127.0.0.1";
const token = process.env.RUNNER_TOKEN?.trim() || "dev-secret";
const maxStdout = Number(process.env.MAX_STDOUT_BYTES ?? 65536);
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

async function execute(body, timeoutMs = 20_000) {
  const res = await fetch(`${base}/api/v2/execute`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

const hello = await execute({
  language: "python",
  version: "*",
  files: [{ name: "main.py", content: "print('isolation-ok')" }],
  stdin: "",
  run_timeout: 3000,
});
if (hello.status !== 200) fail(`hello HTTP ${hello.status}: ${JSON.stringify(hello.json)}`);
const helloRun = asRecord(hello.json.run);
if (!helloRun) fail("hello missing run");
if (Number(helloRun.code) !== 0) fail(`hello expected code 0, got ${helloRun.code} stderr=${helloRun.stderr}`);
if (!String(helloRun.stdout).includes("isolation-ok")) fail(`hello stdout ${JSON.stringify(helloRun.stdout)}`);

const tle = await execute({
  language: "python",
  version: "*",
  files: [{ name: "main.py", content: "while True:\n    pass\n" }],
  stdin: "",
  run_timeout: 800,
});
if (tle.status !== 200) fail(`TLE HTTP ${tle.status}: ${JSON.stringify(tle.json)}`);
const tleRun = asRecord(tle.json.run);
if (!tleRun) fail("TLE missing run");
if (tleRun.signal !== "SIGKILL" && tleRun.signal !== "SIGXCPU") {
  fail(`TLE expected SIGKILL/SIGXCPU, got signal=${tleRun.signal} code=${tleRun.code}`);
}

const net = await execute({
  language: "python",
  version: "*",
  files: [
    {
      name: "main.py",
      content: `import socket
socket.setdefaulttimeout(2)
try:
    socket.create_connection(("1.1.1.1", 80))
    print("NET_OK")
except OSError as e:
    print("NET_BLOCKED")
    print(type(e).__name__)
`,
    },
  ],
  stdin: "",
  run_timeout: 3000,
});
if (net.status !== 200) fail(`net HTTP ${net.status}: ${JSON.stringify(net.json)}`);
const netRun = asRecord(net.json.run);
if (!netRun) fail("net missing run");
const netOut = `${netRun.stdout ?? ""}${netRun.stderr ?? ""}`;
if (netOut.includes("NET_OK")) fail("network should be off; got NET_OK");
if (!netOut.includes("NET_BLOCKED")) {
  fail(`expected NET_BLOCKED, got ${JSON.stringify(netOut)}`);
}

const bomb = await execute({
  language: "python",
  version: "*",
  files: [
    {
      name: "main.py",
      content: "while True:\n    print('x' * 4096)\n",
    },
  ],
  stdin: "",
  run_timeout: 800,
});
if (bomb.status !== 200) fail(`bomb HTTP ${bomb.status}: ${JSON.stringify(bomb.json)}`);
const bombRun = asRecord(bomb.json.run);
if (!bombRun) fail("bomb missing run");
const outLen = String(bombRun.stdout ?? "").length;
const errLen = String(bombRun.stderr ?? "").length;
if (outLen > maxStdout || errLen > maxStdout) {
  fail(`output cap failed stdout=${outLen} stderr=${errLen} max=${maxStdout}`);
}

const health = await fetch(`${base}/health`);
if (!health.ok) fail("runner health failed after bomb");

console.log("A4 isolation ok");
console.log("  hello:", { code: helloRun.code, stdout: JSON.stringify(helloRun.stdout) });
console.log("  TLE:", { code: tleRun.code, signal: tleRun.signal });
console.log("  net:", { stdout: JSON.stringify(String(netRun.stdout).slice(0, 80)) });
console.log("  bomb:", { stdoutChars: outLen, signal: bombRun.signal });
