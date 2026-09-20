import Docker from "dockerode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dockerClient, dockerNamedPipe } from "./docker-engine.js";
import type { StreamResult } from "./execute-types.js";
import { JOB_USER, isolationHostConfig, isolationLimitsFromEnv, isolationTraceDetail } from "./isolation.js";
import type { IsolationLimits } from "./isolation.js";
import type { RuntimeSpec } from "./runtimes.js";
import { preview, trace } from "./trace.js";

export function hostBindPath(absolutePath: string): string {
  return path.resolve(absolutePath).replace(/\\/g, "/");
}

function capBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

function demuxDockerLogs(raw: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const type = raw[offset];
    const size = raw.readUInt32BE(offset + 4);
    const payload = raw.subarray(offset + 8, offset + 8 + size);
    if (type === 2) stderr.push(payload);
    else stdout.push(payload);
    offset += 8 + size;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function emptyRun(): StreamResult {
  // C++: compile failed — Algora still expects a run object
  return { stdout: "", stderr: "", output: "", code: 1, signal: null };
}

function toStreamResult(
  stdout: string,
  stderr: string,
  code: number,
  timedOut: boolean,
  maxBytes: number,
): StreamResult {
  const out = capBytes(stdout, maxBytes);
  const err = capBytes(stderr, maxBytes);
  return {
    stdout: out,
    stderr: err,
    output: capBytes(stdout + stderr, maxBytes),
    code: timedOut ? 137 : code,
    signal: timedOut || code === 137 ? "SIGKILL" : null,
  };
}

function limitsFor(runtime: RuntimeSpec): IsolationLimits {
  const base = isolationLimitsFromEnv();
  if (!runtime.memoryMb) return base;
  // C++: g++ needs more than the 128 MB Python/JS cap
  const memoryBytes = Math.max(32, runtime.memoryMb) * 1024 * 1024;
  return { ...base, memoryBytes };
}

/** C++: capture stdout/stderr from g++ or /tmp/main inside the already-started container. */
async function readExecOutput(
  exec: Docker.Exec,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    onTimeout();
  }, timeoutMs);

  const stream = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  clearTimeout(killer);

  const { stdout, stderr } = demuxDockerLogs(Buffer.concat(chunks));
  let code = 1;
  try {
    const info = (await exec.inspect()) as { ExitCode?: number | null };
    code = Number(info.ExitCode ?? 1);
  } catch {
    code = timedOut ? 137 : 1;
  }
  return { stdout, stderr, code, timedOut };
}

export type IsolatedJobInput = {
  jobId: string;
  runtime: RuntimeSpec;
  source: string;
  stdin: string;
  runTimeoutMs: number;
  compileTimeoutMs: number; // C++: cap g++ time separately from the program
  maxStdoutBytes: number;
};

export type IsolatedJobResult = {
  compile?: StreamResult; // C++: present after g++; omitted for Python/JS
  run: StreamResult;
};

/**
 * Throwaway container: write source + stdin, compile if needed, run, delete.
 * Compiled binaries go to /tmp (writable). /work is read-only.
 */
export async function runIsolatedJob(input: IsolatedJobInput): Promise<IsolatedJobResult> {
  const { jobId, runtime } = input;
  const docker = dockerClient();
  const work = await mkdtemp(path.join(tmpdir(), "algora-job-"));
  const mainPath = path.join(work, runtime.fileName);
  const stdinPath = path.join(work, "stdin.txt");
  const bind = `${hostBindPath(work)}:/work:ro`;
  const keepWork = process.env.RUNNER_KEEP_WORK === "1";
  const compiled = Boolean(runtime.compileCmd && runtime.runCmd); // C++: compile-then-run
  let container: Docker.Container | undefined;

  trace(jobId, "runIsolatedJob", {
    language: runtime.id,
    compiled,
    hostTmpRoot: tmpdir(),
    workDir: work,
    image: runtime.defaultImage,
    fileName: runtime.fileName,
    runTimeoutMs: input.runTimeoutMs,
    compileTimeoutMs: input.compileTimeoutMs,
    dockerPipe: dockerNamedPipe(),
    keepWork,
  });

  try {
    await writeFile(mainPath, input.source, "utf8");
    await writeFile(stdinPath, input.stdin, "utf8");
    trace(jobId, "wrote host files (JSON string → UTF-8 bytes on disk)", {
      mainPath,
      mainBytes: Buffer.byteLength(input.source, "utf8"),
      stdinPath,
      stdinBytes: Buffer.byteLength(input.stdin, "utf8"),
      mainPreview: preview(input.source),
    });

    const limits = limitsFor(runtime);
    const cmd = compiled ? ["sleep", "3600"] : ["/bin/sh", "-c", runtime.shellCmd]; // C++: keep the box alive for g++ then /tmp/main
    trace(jobId, "docker createContainer", {
      bind,
      cmd: compiled ? `sleep; ${runtime.compileCmd}; ${runtime.runCmd}` : runtime.shellCmd,
      isolation: isolationTraceDetail(limits),
    });
    container = await docker.createContainer({
      Image: runtime.defaultImage,
      User: JOB_USER,
      Env: runtime.extraEnv,
      Cmd: cmd,
      WorkingDir: "/work",
      HostConfig: isolationHostConfig(bind, limits),
    });
    const containerId = container.id.slice(0, 12);
    trace(jobId, "docker start", { containerId });
    await container.start();

    // C++: g++ first; if that fails, do not run. Then run /tmp/main.
    if (compiled && runtime.compileCmd && runtime.runCmd) {
      const compileExec = await container.exec({
        Cmd: ["/bin/sh", "-c", runtime.compileCmd],
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: "/work",
        User: JOB_USER,
      });
      const compileOut = await readExecOutput(compileExec, input.compileTimeoutMs, () => {
        trace(jobId, "compile timeout → SIGKILL");
        container?.kill("SIGKILL").catch(() => undefined);
      });
      const compile = toStreamResult(
        compileOut.stdout,
        compileOut.stderr,
        compileOut.code,
        compileOut.timedOut,
        input.maxStdoutBytes,
      );
      trace(jobId, "compile finished", {
        code: compile.code,
        timedOut: compileOut.timedOut,
        stderrPreview: preview(compile.stderr),
      });
      if (compile.code !== 0) {
        return { compile, run: emptyRun() };
      }

      const runExec = await container.exec({
        Cmd: ["/bin/sh", "-c", runtime.runCmd],
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: "/work",
        User: JOB_USER,
      });
      const runOut = await readExecOutput(runExec, input.runTimeoutMs, () => {
        trace(jobId, "run timeout → SIGKILL");
        container?.kill("SIGKILL").catch(() => undefined);
      });
      const run = toStreamResult(
        runOut.stdout,
        runOut.stderr,
        runOut.code,
        runOut.timedOut,
        input.maxStdoutBytes,
      );
      trace(jobId, "container exited", {
        statusCode: run.code,
        timedOut: runOut.timedOut,
        stdoutPreview: preview(run.stdout),
        stderrPreview: preview(run.stderr),
      });
      return { compile, run };
    }

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      trace(jobId, "timeout → SIGKILL", { runTimeoutMs: input.runTimeoutMs });
      container?.kill("SIGKILL").catch(() => undefined);
    }, input.runTimeoutMs);

    let statusCode = 1;
    try {
      const wait = (await container.wait()) as { StatusCode?: number };
      statusCode = Number(wait.StatusCode ?? 1);
    } finally {
      clearTimeout(killer);
    }

    const logBuffer = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;
    const raw = Buffer.isBuffer(logBuffer) ? logBuffer : Buffer.from(String(logBuffer));
    const { stdout, stderr } = demuxDockerLogs(raw);
    const run = toStreamResult(stdout, stderr, statusCode, timedOut, input.maxStdoutBytes);
    trace(jobId, "container exited", {
      statusCode,
      timedOut,
      stdoutPreview: preview(stdout),
      stderrPreview: preview(stderr),
    });
    return { run };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
        trace(jobId, "docker container removed");
      } catch {
        /* already gone */
      }
    }
    if (keepWork) {
      trace(jobId, "kept work dir (RUNNER_KEEP_WORK=1)", { workDir: work });
    } else {
      await rm(work, { recursive: true, force: true });
      trace(jobId, "deleted host work dir", { workDir: work });
    }
  }
}
