export type RuntimeId = "python" | "javascript" | "c++"; // "c++" is what Algora sends

export type RuntimeSpec = {
  id: RuntimeId;
  /** Returned when the client sends version "*" */
  defaultVersion: string;
  defaultImage: string;
  fileName: string;
  /** Used when there is no compile step (Python / JS). */
  shellCmd: string;
  extraEnv: string[];
  compileCmd?: string; // C++: g++ step (Python/JS omit this)
  runCmd?: string; // C++: run the binary after a successful compile
  memoryMb?: number; // C++: extra RAM so g++ does not get killed
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
  shellCmd: "node /work/index.js < /work/stdin.txt",
  extraEnv: ["HOME=/tmp"],
};

// C++: compile main.cpp to /tmp/main, then run it ( /work is read-only )
const CPP: RuntimeSpec = {
  id: "c++",
  defaultVersion: "14.0.0",
  defaultImage: process.env.GCC_IMAGE?.trim() || "gcc:14",
  fileName: "main.cpp",
  shellCmd: "",
  compileCmd: "g++ -O2 -std=c++17 -pipe -o /tmp/main /work/main.cpp",
  runCmd: "/tmp/main < /work/stdin.txt",
  extraEnv: ["HOME=/tmp"],
  memoryMb: 256,
};

const BY_ID: Record<RuntimeId, RuntimeSpec> = {
  python: PYTHON,
  javascript: JAVASCRIPT,
  "c++": CPP,
};

export function isRuntimeId(value: string): value is RuntimeId {
  return value === "python" || value === "javascript" || value === "c++";
}

export function runtimeFor(language: string): RuntimeSpec | null {
  if (language === "cpp") return BY_ID["c++"]; // C++: Postman alias; Algora uses "c++"
  if (!isRuntimeId(language)) return null;
  return BY_ID[language];
}

export const ENABLED_LANGUAGES: RuntimeId[] = ["python", "javascript", "c++"]; // C++: A6
