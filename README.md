# algora-runner

Local HTTP executor for [Algora](docs/from-algora/CODE_EXECUTION.md): it runs a learner program in a throwaway Docker container and returns stdout, stderr, and exit status so the website can score Run/Submit without talking to Docker itself.

A request hits `POST /api/v2/execute` on loopback. The handler checks `Authorization` against `RUNNER_TOKEN`, accepts one source file (`python`, `javascript`, `c++`, or `java`), clamps size and timeouts, then waits in a one-job queue. Node writes the file plus stdin under `%TEMP%`, bind-mounts that folder read-only at `/work`, and starts an isolated container. Python and JavaScript run the interpreter; C++ and Java compile into `/tmp` then run. The JSON uses the `/api/v2` prefix so Algora’s existing client can keep the same path. This is not Piston, not a public SaaS, and not `eval` in the Node process. The host does not need Python, Node, g++, or a JDK for learner code — those exist only inside the images.

## Quick start

**Need:** Node 22+, Docker Desktop with the **Linux** engine running (`docker version` → Server OS `linux`, Arch `amd64` on this PC).

Pull the images once (first execute is slow if they are missing; the runner does not pull for you):

```powershell
docker run --rm python:3.12-slim python -c "print(1)"
docker run --rm node:22-slim node -e "console.log(1)"
docker run --rm gcc:14 g++ --version
docker run --rm eclipse-temurin:21-jdk javac -version
```

```powershell
cd D:\OneDrive\projects\algora-runner
copy .env.example .env
npm install
npm run start
```

The process prints `listening on http://127.0.0.1:<port>`. If `PORT` is taken it tries `PORT+1` (up to 20). Use that URL. `npm run dev` is the same entry with file watch.

In another terminal (JSON in a file so PowerShell does not eat `()`):

```powershell
curl.exe -s http://127.0.0.1:2000/health
curl.exe -s -X POST http://127.0.0.1:2000/api/v2/execute -H "Authorization: dev-secret" -H "Content-Type: application/json" --data-binary "@docs/examples/python-stdin.json"
```

Health should include `"ok": true` and the four languages. Execute should be HTTP 200 with `run.code` `0` and `run.stdout` containing `hello`. Wrong or missing `Authorization` → 401. Watch `[job-…]` lines in the **runner** terminal ([TRACE.md](docs/TRACE.md)).

## Configuration

Copy `.env.example` to `.env` (do not commit `.env`). `tsx --env-file=.env` loads it.

| Variable | Default | Role |
|----------|---------|------|
| `RUNNER_TOKEN` | *(required)* | Secret. Must equal the `Authorization` header. Same string Algora stores as `EXECUTOR_TOKEN`. |
| `HOST` | `127.0.0.1` | Bind address. Do not set `0.0.0.0` unless you intend to expose execute. |
| `PORT` | `2000` | Preferred listen port. |
| `PYTHON_IMAGE` | `python:3.12-slim` | Python jobs |
| `NODE_IMAGE` | `node:22-slim` | JavaScript jobs |
| `GCC_IMAGE` | `gcc:14` | C++ jobs |
| `JAVA_IMAGE` | `eclipse-temurin:21-jdk` | Java jobs |
| `MAX_SOURCE_CHARS` | `10000` | Max `files[0].content` length |
| `MAX_RUN_TIMEOUT_MS` | `10000` | Cap on `run_timeout` (ms) |
| `MAX_COMPILE_TIMEOUT_MS` | `10000` | Cap on `compile_timeout` (ms); used for `g++` / `javac` |
| `MAX_STDOUT_BYTES` | `65536` | Cap on returned stdout/stderr |
| `ISOLATION_MEMORY_MB` | `128` | Job RAM cap (C++ uses 256 MB, Java 384 MB) |
| `ISOLATION_PIDS_LIMIT` | `64` | Job PID cap |
| `ISOLATION_TMPFS_SIZE` | `32m` | Writable `/tmp` (binaries and `.class` files) |
| `ISOLATION_LOG_MAX_SIZE` | `64k` | Docker json-file log cap |
| `RUNNER_KEEP_WORK` | unset | `1` keeps the temp folder after the job |
| `DOCKER_NAMED_PIPE` | auto | Windows pipe override |
| `DOCKER_HOST` | unset | If set, dockerode uses the default Docker env instead of the named pipe |

## Execute API

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/health` | none |
| `POST` | `/api/v2/execute` | `Authorization` exactly `RUNNER_TOKEN` (not a Bearer prefix unless that is the token) |

One file per request. Languages: `python`, `javascript`, `c++` (alias `cpp`), `java`. `version: "*"` means the image above; the response reports `3.12.0` / `22.0.0` / `14.0.0` / `21.0.0`.

Request (see `docs/examples/`):

```json
{
  "language": "python",
  "version": "*",
  "files": [{ "name": "main.py", "content": "print(input())" }],
  "stdin": "hello\n",
  "compile_timeout": 10000,
  "run_timeout": 3000
}
```

Interesting response fields: `run.stdout`, `run.stderr`, `run.code`, `run.signal` (`SIGKILL` on timeout). C++ and Java also send `compile`; non-zero `compile.code` is a compile error and there is no real run. Algora maps those fields to AC / CE / TLE / RE ([A3_CONTRACT.md](docs/A3_CONTRACT.md)). HTTP 400 is a bad body; 502 is Docker/runner failure.

## Layout

| Path | Why it exists |
|------|----------------|
| `src/index.ts` | Bind loopback, `/health`, `/api/v2/execute` |
| `src/auth.ts` | Compare `Authorization` to `RUNNER_TOKEN` |
| `src/execute-handler.ts` | Validate JSON, clamp limits, call the job |
| `src/runtimes.ts` | Image, filename, and commands per language |
| `src/container-job.ts` | Temp files, Docker create/exec, logs, cleanup |
| `src/isolation.ts` | Job `HostConfig` (no net, caps, non-root, …) |
| `src/docker-engine.ts` | Named pipe / socket to Docker Desktop |
| `src/job-lock.ts` | One container at a time |
| `src/trace.ts` / `src/verdict.ts` | Terminal breadcrumbs; same verdict rules as Algora |
| `scripts/check-a*.mjs` | HTTP smoke tests against a running runner |

## Limits and threat model

Callers: you (curl/Postman) or, after wiring, the Algora **server** on the same PC. Jobs: no network, 1 CPU, memory/PID caps, read-only root, dropped capabilities, user `65534:65534`. Docker still shares the host kernel — this is a **dev / self-host** executor, not a public anonymous judge. Do not publish the port. Details: [THREAT_MODEL.md](docs/THREAT_MODEL.md), [ISOLATION.md](docs/ISOLATION.md).

**Not in this repo:** Ampere (arm64) deploy. Pointing Algora at the runner is documented in [A8.md](docs/A8.md); `npm run check:a8` lives in **problem-solver**, not here.

## Verify

Runner must already be listening. Checks probe `PORT`, then `2000` / `2001`.

| Command | What it proves |
|---------|----------------|
| `npm run typecheck` | TypeScript |
| `npm run check:a3` | Python contract (success + runtime error + TLE) |
| `npm run check:a4` | Isolation: TLE, no outbound net, output cap |
| `npm run check:a5` | JavaScript + Python still work |
| `npm run check:a6` | C++ compile/run |
| `npm run check:a7` | Java `javac` then `java` |
