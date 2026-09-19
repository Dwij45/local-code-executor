import Docker from "dockerode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StreamResult } from "./execute-types.js";

function dockerClient(): Docker {
  if (process.platform === "win32") {
    return new Docker({ socketPath: "//./pipe/docker_engine" });
  }
  return new Docker({ socketPath: "/var/run/docker.sock" });
}

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
  const docker = dockerClient();
  const work = await mkdtemp(path.join(tmpdir(), "algora-job-"));
  let container: Docker.Container | undefined;
  let timedOut = false;

  try {
    await writeFile(path.join(work, "main.py"), input.source, "utf8");
    await writeFile(path.join(work, "stdin.txt"), input.stdin, "utf8");

    container = await docker.createContainer({
      Image: input.image,
      Cmd: ["/bin/sh", "-c", "python -u /work/main.py < /work/stdin.txt"],
      WorkingDir: "/work",
      HostConfig: {
        Binds: [`${hostBindPath(work)}:/work:ro`],
        AutoRemove: false,
      },
    });

    await container.start();

    const killer = setTimeout(() => {
      timedOut = true;
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

    return {
      stdout: capBytes(stdout, input.maxStdoutBytes),
      stderr: capBytes(stderr, input.maxStdoutBytes),
      output: capBytes(stdout + stderr, input.maxStdoutBytes),
      code: timedOut ? 137 : statusCode,
      signal: timedOut || statusCode === 137 ? "SIGKILL" : null,
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch {
        /* already gone */
      }
    }
    await rm(work, { recursive: true, force: true });
  }
}
