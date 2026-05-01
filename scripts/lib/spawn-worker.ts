import { spawn, type ChildProcess } from "node:child_process"

export interface SpawnedWorker {
  child: ChildProcess
  port: number
  kill: () => Promise<void>
}

/** Spawns `wrangler dev --local` in a child process and waits until the
 * worker is reachable on its port. Streams stdout/stderr with a label
 * prefix so the orchestrator's combined output is greppable. */
export async function spawnWranglerDev(opts: {
  cwd: string
  port: number
  label: string
  env?: Record<string, string>
}): Promise<SpawnedWorker> {
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--port", String(opts.port), "--ip", "127.0.0.1"],
    {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  child.stdout?.on("data", (b) => process.stdout.write(`[${opts.label}] ${b}`))
  child.stderr?.on("data", (b) => process.stderr.write(`[${opts.label}] ${b}`))

  // Wait for the worker to be reachable. Throw if it never comes up.
  const start = Date.now()
  let ready = false
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/`)
      if (r.status < 500) { ready = true; break }
    } catch {
      // not yet reachable
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) {
    child.kill("SIGKILL")
    throw new Error(`[${opts.label}] timed out waiting for :${opts.port}`)
  }

  return {
    child,
    port: opts.port,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.killed) return resolve()
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL")
          resolve()
        }, 5_000)
      }),
  }
}
