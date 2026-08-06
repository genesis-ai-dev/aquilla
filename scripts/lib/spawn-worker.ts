import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"

export interface SpawnedWorker {
  child: ChildProcess
  port: number
  kill: () => Promise<void>
}

export function wranglerDevArgs(opts: {
  port: number
  inspectorPort?: number
  extraArgs?: string[]
}): string[] {
  return [
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(opts.port),
    "--ip",
    "127.0.0.1",
    "--inspector-port",
    String(opts.inspectorPort ?? 0),
    ...(opts.extraArgs ?? []),
  ]
}

/** Kill a process and any descendants. wrangler dev wraps a workerd child
 * that doesn't always die when the npx parent gets SIGTERM, leaving
 * orphans that hold ports across runs. We use `pkill -P` to walk the
 * tree, then SIGKILL the parent if it still hasn't exited. */
function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  // Kill children first (reaping bottom-up keeps a workerd-style daemon from
  // getting reparented to PID 1 and surviving its parent).
  spawnSync("pkill", [signal === "SIGKILL" ? "-9" : "-15", "-P", String(pid)])
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

/** Spawns `wrangler dev --local` in a child process and waits until the
 * worker is reachable on its port. Streams stdout/stderr to a log file
 * (silent by default); pass `streamToParent: true` to also tee to this
 * process's stdout/stderr (used by --verbose). */
export async function spawnWranglerDev(opts: {
  cwd: string
  port: number
  /** Inspector port exposed by Wrangler. Zero asks the OS for a free port,
   * which prevents concurrent dev/E2E stacks from racing on port 9229. */
  inspectorPort?: number
  label: string
  env?: Record<string, string>
  /** Extra flags appended to the `wrangler dev` invocation, e.g.
   * `["--persist-to", ".wrangler-dev-state"]` to share local D1 state. */
  extraArgs?: string[]
  logFile?: WriteStream
  streamToParent?: boolean
}): Promise<SpawnedWorker> {
  const child = spawn(
    "npx",
    wranglerDevArgs(opts),
    {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  attachOutput(child, opts.label, opts.logFile, opts.streamToParent ?? false)

  // Wait for the worker to be reachable. Throw if it never comes up. The
  // window is generous because a cold wrangler boot competes with parallel
  // dev stacks (worktree QA sessions) for CPU and can take ~1 min.
  const start = Date.now()
  let ready = false
  while (Date.now() - start < 120_000) {
    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (r.status < 500) { ready = true; break }
    } catch {
      // not yet reachable
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) {
    if (child.pid) killTree(child.pid, "SIGKILL")
    throw new Error(`[${opts.label}] timed out waiting for :${opts.port}`)
  }

  return {
    child,
    port: opts.port,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.killed || child.exitCode !== null) return resolve()
        child.once("exit", () => resolve())
        if (child.pid) killTree(child.pid, "SIGTERM")
        setTimeout(() => {
          if (!child.killed && child.exitCode === null && child.pid) {
            killTree(child.pid, "SIGKILL")
          }
          resolve()
        }, 5_000)
      }),
  }
}

/** Wire a child's stdout/stderr into a log file (and optionally also tee
 * to the parent process's stdout/stderr). The label is prefixed onto each
 * line written to the parent, but written verbatim to the log file. */
export function attachOutput(
  child: ChildProcess,
  label: string,
  logFile?: WriteStream,
  streamToParent = false,
): void {
  if (logFile) {
    child.stdout?.pipe(logFile, { end: false })
    child.stderr?.pipe(logFile, { end: false })
  } else {
    // Drain the streams even if we're not logging — otherwise the child's
    // stdio buffer fills and it blocks.
    child.stdout?.on("data", () => {})
    child.stderr?.on("data", () => {})
  }
  if (streamToParent) {
    child.stdout?.on("data", (b) => process.stdout.write(`[${label}] ${b}`))
    child.stderr?.on("data", (b) => process.stderr.write(`[${label}] ${b}`))
  }
}

/** Same kill-tree pattern but for a generic spawned child (Vite, etc.). */
export function killChildTree(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.killed || child.exitCode !== null) return resolve()
    child.once("exit", () => resolve())
    if (child.pid) killTree(child.pid, "SIGTERM")
    setTimeout(() => {
      if (!child.killed && child.exitCode === null && child.pid) {
        killTree(child.pid, "SIGKILL")
      }
      resolve()
    }, 5_000)
  })
}

/** Open a log file write stream, replacing any prior contents. */
export function openLogFile(filePath: string): WriteStream {
  return createWriteStream(filePath, { flags: "w" })
}
