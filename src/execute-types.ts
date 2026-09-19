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
  compile_timeout?: number;
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
  run: StreamResult;
};
