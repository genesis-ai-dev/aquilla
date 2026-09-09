import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import os from "node:os"
import path from "node:path"

export interface SpawnedWorker {
  child: ChildProcess
  port: number
  kill: () => Promise<void>
}

const INSPECTOR_PORT_OFFSET = 10_000

/** Derive a stable inspector port from the worker's already-isolated HTTP port.
 * This keeps concurrent E2E shards collision-free without relying on Wrangler's
 * unstable `--inspector-port 0` proxy path. */
export function inspectorPortForWorkerPort(workerPort: number): number {
  return workerPort + INSPECTOR_PORT_OFFSET
}

export function wranglerDevArgs(opts: {
  port: number
  inspectorPort?: number
  extraArgs?: string[]
  /** Overrides wrangler.toml `name` so concurrent stacks do not share one
   * `~/.wrangler/registry/<name>` heartbeat file. */
  name?: string
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
    String(opts.inspectorPort ?? inspectorPortForWorkerPort(opts.port)),
    ...(opts.name ? ["--name", opts.name] : []),
    ...(opts.extraArgs ?? []),
  ]
}

/** Directory for this worker's file-based dev registry. Port is already
 * unique across e2e shards and the live `pnpm dev` stack. */
export function defaultWranglerRegistryDir(label: string, port: number): string {
  return path.join(os.tmpdir(), `aquilla-wrangler-registry-${label}-${port}`)
}

/** Env that keeps Wrangler/Miniflare off the shared user-level registry.
 * Concurrent `wrangler dev` processes that share
 * `~/Library/Preferences/.wrangler/registry/<worker-name>` crash when one
 * unlinks the file and another's heartbeat calls `utimesSync` (ENOENT). */
export function wranglerRegistryEnv(registryDir: string): Record<string, string> {
  return {
    WRANGLER_REGISTRY_PATH: registryDir,
    MINIFLARE_REGISTRY_PATH: registryDir,
  }
}

/** Local worker name that cannot collide with `pnpm dev` or another e2e
 * shard. Wrangler 3.114 heartbeats `utimesSync` on the toml `name` even
 * when `WRANGLER_REGISTRY_PATH` is unset/ignored. */
export function isolatedWranglerName(baseName: string, suffix: string): string {
  return `${baseName}-e2e${suffix}`
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

/** Keep the local proxy below its five-second idle-connection race while
 * WebSockets are open (workers-sdk #14641 / #15452). E2E only: this does not
 * retry application requests or recover a failed worker. A probe failure
 * stops the loop and invalidates the run through onError.
 */
export function startWorkerProxyKeepAlive(
  url: string,
  onError: (error: unknown) => void,
): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
  }
  const probe = async () => {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10_000),
        ]),
      })
      // The workers' root route may return 404. Consume the entire response
      // so this probe does not itself abandon a body in the proxy.
      await response.arrayBuffer()
      if (response.status >= 500) {
        throw new Error(`Local worker proxy returned HTTP ${response.status}`)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        stop()
        onError(error)
      }
    } finally {
      // Schedule after completion: a slow worker never accumulates probes.
      if (!controller.signal.aborted) timer = setTimeout(() => void probe(), 1_000)
    }
  }
  void probe()
  return stop
}

/** Spawns `wrangler dev --local` in a child process and waits until the
 * worker is reachable on its port. Streams stdout/stderr to a log file
 * (silent by default); pass `streamToParent: true` to also tee to this
 * process's stdout/stderr (used by --verbose). */
export async function spawnWranglerDev(opts: {
  cwd: string
  port: number
  /** Inspector port exposed by Wrangler. By default this is derived from the
   * worker's HTTP port so concurrent dev/E2E stacks cannot collide. */
  inspectorPort?: number
  label: string
  env?: Record<string, string>
  /** Extra flags appended to the `wrangler dev` invocation, e.g.
   * `["--persist-to", ".wrangler-dev-state"]` to share local D1 state. */
  extraArgs?: string[]
  /** Overrides wrangler.toml `name` for the local registry heartbeat file. */
  name?: string
  /** File-based dev registry directory. Defaults to a per-label/port tmp
   * dir so concurrent stacks never share `~/.wrangler/registry/<name>`. */
  registryDir?: string
  logFile?: WriteStream
  streamToParent?: boolean
}): Promise<SpawnedWorker> {
  const registryDir = opts.registryDir ?? defaultWranglerRegistryDir(opts.label, opts.port)
  mkdirSync(registryDir, { recursive: true })
  const child = spawn(
    "npx",
    wranglerDevArgs(opts),
    {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        // Always win over a leaked parent `WRANGLER_REGISTRY_PATH` so this
        // process cannot share `~/.wrangler/registry/<name>` with another stack.
        ...wranglerRegistryEnv(registryDir),
      },
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
