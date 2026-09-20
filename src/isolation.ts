import type Docker from "dockerode";

/** nobody:nogroup — jobs must not be root */
export const JOB_USER = "65534:65534";

export type IsolationLimits = {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  tmpfsSize: string;
  logMaxSize: string;
};

export function isolationLimitsFromEnv(): IsolationLimits {
  const memoryMb = Number(process.env.ISOLATION_MEMORY_MB ?? 128);
  return {
    memoryBytes: Math.max(32, memoryMb) * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    pidsLimit: Number(process.env.ISOLATION_PIDS_LIMIT ?? 64),
    tmpfsSize: process.env.ISOLATION_TMPFS_SIZE ?? "32m", // C++: room for /tmp/main
    logMaxSize: process.env.ISOLATION_LOG_MAX_SIZE ?? "64k",
  };
}

/**
 * Docker HostConfig for untrusted jobs (A4 isolation).
 * Namespaces/cgroups/caps: no net, RAM+swap cap, 1 CPU, pid cap, read-only root,
 * tmpfs /tmp, drop all capabilities, no privilege regain, non-root user.
 * Applied only to the job container — never to the Node runner process.
 */
export function isolationHostConfig(
  bind: string,
  limits: IsolationLimits,
): Docker.ContainerCreateOptions["HostConfig"] {
  return {
    Binds: [bind],
    AutoRemove: false,
    NetworkMode: "none",
    Memory: limits.memoryBytes,
    MemorySwap: limits.memoryBytes,
    NanoCpus: limits.nanoCpus,
    PidsLimit: limits.pidsLimit,
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    // C++: /tmp must be writable and executable so g++ can emit /tmp/main and we can run it
    Tmpfs: { "/tmp": `rw,nosuid,nodev,exec,size=${limits.tmpfsSize},mode=1777` },
    LogConfig: {
      Type: "json-file",
      Config: { "max-size": limits.logMaxSize, "max-file": "1" },
    },
  };
}

export function isolationTraceDetail(limits: IsolationLimits): Record<string, unknown> {
  return {
    network: "none",
    memoryBytes: limits.memoryBytes,
    memorySwapBytes: limits.memoryBytes,
    nanoCpus: limits.nanoCpus,
    pidsLimit: limits.pidsLimit,
    readonlyRootfs: true,
    tmpfs: `/tmp ${limits.tmpfsSize}`,
    capDrop: "ALL",
    securityOpt: "no-new-privileges",
    user: JOB_USER,
    logMaxSize: limits.logMaxSize,
  };
}
