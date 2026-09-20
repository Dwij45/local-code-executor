export type SourceFile = {
  name: string;
  content: string;
};

/** Incoming JSON — same fields Algora's execute client already POSTs. */
export type ExecuteRequest = {
  language: string;
  version?: string;
  files: SourceFile[];
  stdin?: string;
  compile_timeout?: number; // C++ / Java: milliseconds for g++ / javac
  run_timeout?: number;
};

/** Outgoing JSON — Algora maps run.code / run.stdout / run.stderr / run.signal. */
export type StreamResult = {
  stdout: string;
  stderr: string;
  output: string;
  code: number;
  signal: string | null;
};

export type ExecuteResponse = {
  language: string;
  version: string;
  compile?: StreamResult; // C++ / Java: Algora maps compile.code !== 0 to compilation error
  run: StreamResult;
};
