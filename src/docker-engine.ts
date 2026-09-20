import { existsSync } from "node:fs";
import Docker from "dockerode";

/**
 * Talk to Docker Desktop / Engine from the Node runner (never from the job).
 * Current Docker Desktop on Windows uses `dockerDesktopLinuxEngine`, not `docker_engine`.
 */
export function dockerNamedPipe(): string {
  if (process.platform !== "win32") return "/var/run/docker.sock";
  const candidates = [
    process.env.DOCKER_NAMED_PIPE?.trim(),
    "//./pipe/dockerDesktopLinuxEngine",
    "//./pipe/docker_engine",
  ].filter((p): p is string => Boolean(p));
  for (const pipe of candidates) {
    if (existsSync(pipe)) return pipe;
  }
  return candidates[0] ?? "//./pipe/dockerDesktopLinuxEngine";
}

export function dockerClient(): Docker {
  if (process.env.DOCKER_HOST?.trim()) {
    return new Docker();
  }
  return new Docker({ socketPath: dockerNamedPipe() });
}
