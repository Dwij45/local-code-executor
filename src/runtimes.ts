export type RuntimeId = "python" | "javascript";

export type RuntimeSpec = {
  id: RuntimeId;
  /** Returned when the client sends version "*" */
  defaultVersion: string;
  defaultImage: string;
  fileName: string;
  shellCmd: string;
  extraEnv: string[];
};

const PYTHON: RuntimeSpec = {
  id: "python",
  defaultVersion: "3.12.0",
  defaultImage: process.env.PYTHON_IMAGE?.trim() || "python:3.12-slim",
  fileName: "main.py",
  shellCmd: "python -u /work/main.py < /work/stdin.txt",
  extraEnv: ["HOME=/tmp", "PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1"],
};

const JAVASCRIPT: RuntimeSpec = {
  id: "javascript",
  defaultVersion: "22.0.0",
  defaultImage: process.env.NODE_IMAGE?.trim() || "node:22-slim",
  fileName: "index.js",
  // fd 0 — Algora wrap uses readFileSync(0)
  shellCmd: "node /work/index.js < /work/stdin.txt",
  extraEnv: ["HOME=/tmp"],
};

const BY_ID: Record<RuntimeId, RuntimeSpec> = {
  python: PYTHON,
  javascript: JAVASCRIPT,
};

export function isRuntimeId(value: string): value is RuntimeId {
  return value === "python" || value === "javascript";
}

export function runtimeFor(language: string): RuntimeSpec | null {
  if (!isRuntimeId(language)) return null;
  return BY_ID[language];
}

export const ENABLED_LANGUAGES: RuntimeId[] = ["python", "javascript"];
