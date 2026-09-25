/**
 * A7: Java compile then run; compile error; Python still has no compile key.
 * Usage: npm run check:a7
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

async function execute(body, timeoutMs = 90_000) {
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

const py = await execute({
  language: "python",
  version: "*",
  files: [{ name: "main.py", content: "print(2 + 2)" }],
  stdin: "",
  run_timeout: 3000,
});
if (py.status !== 200) fail(`python HTTP ${py.status}: ${JSON.stringify(py.json)}`);
if (py.json.compile) fail("Python must not send compile");
if (Number(asRecord(py.json.run)?.code) !== 0) fail("python should still pass");

const hello = await execute({
  language: "java",
  version: "*",
  files: [
    {
      name: "Main.java",
      content:
        'public class Main {\n  public static void main(String[] a) {\n    System.out.println("java-ok");\n  }\n}\n',
    },
  ],
  stdin: "",
  compile_timeout: 10000,
  run_timeout: 10000,
});
if (hello.status !== 200) fail(`hello HTTP ${hello.status}: ${JSON.stringify(hello.json)}`);
if (hello.json.language !== "java") fail(`language ${hello.json.language}`);
const helloCompile = asRecord(hello.json.compile);
if (!helloCompile) fail("Java success should include compile");
if (Number(helloCompile.code) !== 0) {
  fail(`compile should be 0, got ${helloCompile.code} ${helloCompile.stderr}`);
}
const helloRun = asRecord(hello.json.run);
if (!helloRun) fail("hello missing run");
if (Number(helloRun.code) !== 0) fail(`run code ${helloRun.code} stderr=${helloRun.stderr}`);
if (!String(helloRun.stdout).includes("java-ok")) fail(`stdout ${JSON.stringify(helloRun.stdout)}`);

const bad = await execute({
  language: "java",
  version: "*",
  files: [{ name: "Main.java", content: "public class Main {\n" }],
  stdin: "",
  compile_timeout: 10000,
  run_timeout: 10000,
});
if (bad.status !== 200) fail(`CE HTTP ${bad.status}: ${JSON.stringify(bad.json)}`);
const badCompile = asRecord(bad.json.compile);
if (!badCompile) fail("CE missing compile");
if (Number(badCompile.code) === 0) fail("broken Java should fail compile");
if (!String(badCompile.stderr) && !String(badCompile.output)) fail("compile stderr should explain the error");

console.log("A7 java ok");
console.log("  hello:", { compile: helloCompile.code, run: helloRun.code, stdout: JSON.stringify(helloRun.stdout) });
console.log("  CE:", { compile: badCompile.code });
