import Docker from "dockerode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dockerClient, dockerNamedPipe } from "./docker-engine.js";
import type { StreamResult } from "./execute-types.js";
import { JOB_ENV, JOB_USER, isolationHostConfig, isolationLimitsFromEnv, isolationTraceDetail } from "./isolation.js";
import { preview, trace } from "./trace.js";

/** Docker Desktop on Windows wants bind sources with forward slashes. */
export function hostBindPath(absolutePath: string): string {
  return path.resolve(absolutePath).replace(/\\/g, "/");
}

function capBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

/** Docker log stream: 8-byte header then payload (type 1 stdout, 2 stderr). */
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

export type PythonJobInput = {
  jobId: string;
  source: string;
  stdin: string;
  runTimeoutMs: number;
  image: string;
  maxStdoutBytes: number;
};

/**
 * Run learner Python in a throwaway container.
 * Stdin is a file (not attach) so Windows dockerode does not race start vs stdin.
 * The job never sees the Docker named pipe — only this Node process talks to the engine.
 */
export async function runPythonJob(input: PythonJobInput): Promise<StreamResult> {
  const { jobId } = input;
  const docker = dockerClient();
  const work = await mkdtemp(path.join(tmpdir(), "algora-job-"));
  const mainPath = path.join(work, "main.py");
  const stdinPath = path.join(work, "stdin.txt");
  const bind = `${hostBindPath(work)}:/work:ro`;
  const keepWork = process.env.RUNNER_KEEP_WORK === "1";
  let container: Docker.Container | undefined;
  let timedOut = false;

  trace(jobId, "python-job.ts runPythonJob", {
    hostTmpRoot: tmpdir(),
    workDir: work,
    image: input.image,
    runTimeoutMs: input.runTimeoutMs,
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

    const limits = isolationLimitsFromEnv();
    trace(jobId, "docker createContainer", {
      bind,
      cmd: "python -u /work/main.py < /work/stdin.txt",
      isolation: isolationTraceDetail(limits),
    });
    container = await docker.createContainer({
      Image: input.image,
      User: JOB_USER,
      Env: JOB_ENV,
      Cmd: ["/bin/sh", "-c", "python -u /work/main.py < /work/stdin.txt"],
      WorkingDir: "/work",
      HostConfig: isolationHostConfig(bind, limits),
    });
    const containerId = container.id.slice(0, 12);
    trace(jobId, "docker start", { containerId });
    await container.start();

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
    const stdoutCapped = capBytes(stdout, input.maxStdoutBytes);
    const stderrCapped = capBytes(stderr, input.maxStdoutBytes);
    trace(jobId, "container exited", {
      statusCode,
      timedOut,
      stdoutPreview: preview(stdout),
      stderrPreview: preview(stderr),
      stdoutCapped: stdoutCapped.length < stdout.length,
      stderrCapped: stderrCapped.length < stderr.length,
    });

    return {
      stdout: stdoutCapped,
      stderr: stderrCapped,
      output: capBytes(stdout + stderr, input.maxStdoutBytes),
      code: timedOut ? 137 : statusCode,
      signal: timedOut || statusCode === 137 ? "SIGKILL" : null,
    };
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
