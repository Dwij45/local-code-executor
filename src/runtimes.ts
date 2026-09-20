export type RuntimeId = "python" | "javascript" | "c++" | "java"; // "c++" is what Algora sends

export type RuntimeSpec = {
  id: RuntimeId;
  /** Returned when the client sends version "*" */
  defaultVersion: string;
  defaultImage: string;
  fileName: string;
  /** Used when there is no compile step (Python / JS). */
  shellCmd: string;
  extraEnv: string[];
  compileCmd?: string; // C++ / Java: compiler step (Python/JS omit this)
  runCmd?: string; // C++ / Java: run after a successful compile
  memoryMb?: number; // C++ / Java: extra RAM so g++ / javac+JVM are not killed
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

// for Java: javac cannot write .class into /work (read-only), so -d /tmp then java -cp /tmp
const JAVA: RuntimeSpec = {
  id: "java",
  defaultVersion: "21.0.0",
  defaultImage: process.env.JAVA_IMAGE?.trim() || "eclipse-temurin:21-jdk",
  fileName: "Main.java",
  shellCmd: "",
  compileCmd: "javac -d /tmp /work/Main.java",
  runCmd: "java -cp /tmp Main < /work/stdin.txt",
  extraEnv: ["HOME=/tmp", "JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=/tmp"],
  memoryMb: 384,
};

const BY_ID: Record<RuntimeId, RuntimeSpec> = {
  python: PYTHON,
  javascript: JAVASCRIPT,
  "c++": CPP,
  java: JAVA,
};

export function isRuntimeId(value: string): value is RuntimeId {
  return value === "python" || value === "javascript" || value === "c++" || value === "java";
}

export function runtimeFor(language: string): RuntimeSpec | null {
  if (language === "cpp") return BY_ID["c++"]; // C++: Postman alias; Algora uses "c++"
  if (!isRuntimeId(language)) return null;
  return BY_ID[language];
}

export const ENABLED_LANGUAGES: RuntimeId[] = ["python", "javascript", "c++", "java"]; // Java: A7
