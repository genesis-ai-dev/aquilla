import { spawn } from "node:child_process"
import { existsSync, writeFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnWranglerDev, type SpawnedWorker } from "./lib/spawn-worker"
import { MockLLMServer } from "../e2e/helpers/mock-llm-server"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const FRONTIER_SERVER_DIR =
  process.env.FRONTIER_SERVER_DIR ?? path.join(homedir(), "frontierrnd/frontier-server")
const SYNC_WORKER_DIR = path.join(REPO_ROOT, "sync-worker")
const FRONTIER_PORT = 8787
const SYNC_WORKER_PORT = 8788
const VITE_PORT = 5173

const cleanup: Array<() => Promise<void>> = []

let shuttingDown = false
async function shutdown(code = 0): Promise<never> {
  if (shuttingDown) {
    // A second SIGINT during teardown — give up on graceful and exit hard.
    process.exit(code)
  }
  shuttingDown = true
  console.log("\n[e2e-up] shutting down…")
  // Iterate a copy so the array isn't mutated.
  for (const fn of [...cleanup].reverse()) {
    try { await fn() } catch (e) { console.error(e) }
  }
  process.exit(code)
}

process.on("SIGINT", () => { void shutdown(130) })
process.on("SIGTERM", () => { void shutdown(143) })

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

function runOnce(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: "inherit" })
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exit ${code}`))))
  })
}

async function main(): Promise<void> {
  if (!existsSync(FRONTIER_SERVER_DIR)) {
    console.error(`[e2e-up] frontier-server not found at ${FRONTIER_SERVER_DIR}`)
    console.error(`[e2e-up] set FRONTIER_SERVER_DIR or clone the repo`)
    process.exit(1)
  }
  if (!existsSync(SYNC_WORKER_DIR)) {
    console.error(`[e2e-up] sync-worker not found at ${SYNC_WORKER_DIR}`)
    process.exit(1)
  }

  // 1. Reset frontier-server local D1 by deleting wrangler state
  const wranglerStateDir = path.join(FRONTIER_SERVER_DIR, ".wrangler")
  console.log(`[e2e-up] resetting wrangler local state at ${wranglerStateDir}`)
  rmSync(wranglerStateDir, { recursive: true, force: true })

  // 2. Apply migrations
  console.log("[e2e-up] applying frontier-server migrations…")
  await runOnce("npx", ["wrangler", "d1", "migrations", "apply", "frontier-db-v2", "--local"], FRONTIER_SERVER_DIR)

  // 3. Boot frontier-server
  console.log(`[e2e-up] starting frontier-server on :${FRONTIER_PORT}…`)
  const frontier: SpawnedWorker = await spawnWranglerDev({
    cwd: FRONTIER_SERVER_DIR,
    port: FRONTIER_PORT,
    label: "frontier",
    env: { WRANGLER_LOCAL: "1" },
  })
  cleanup.push(() => frontier.kill())

  // 4. Boot sync-worker
  console.log(`[e2e-up] starting sync-worker on :${SYNC_WORKER_PORT}…`)
  const sync: SpawnedWorker = await spawnWranglerDev({
    cwd: SYNC_WORKER_DIR,
    port: SYNC_WORKER_PORT,
    label: "sync",
  })
  cleanup.push(() => sync.kill())

  // 5. Boot mock LLM
  console.log("[e2e-up] starting mock LLM…")
  const mockLLM = new MockLLMServer()
  await mockLLM.start()
  console.log(`[e2e-up] mock LLM ready at ${mockLLM.baseUrl}`)
  cleanup.push(async () => mockLLM.stop())

  // 6. Write .env.test.local
  const envFile = path.join(REPO_ROOT, ".env.test.local")
  writeFileSync(
    envFile,
    [
      `VITE_FRONTIER_BASE=http://127.0.0.1:${FRONTIER_PORT}`,
      `VITE_SYNC_WORKER_HOST=127.0.0.1:${SYNC_WORKER_PORT}`,
      `VITE_LLM_BASE_URL=${mockLLM.baseUrl}`,
      "",
    ].join("\n"),
  )
  cleanup.push(async () => rmSync(envFile, { force: true }))
  console.log(`[e2e-up] wrote ${envFile}`)

  // 7. Boot Vite
  console.log(`[e2e-up] starting Vite on :${VITE_PORT}…`)
  // `--mode test` makes Vite load .env.test.local (Vite reads its mode from
  // the CLI flag, not the MODE shell env var).
  const vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort", "--mode", "test"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  })
  vite.stdout?.on("data", (b) => process.stdout.write(`[vite] ${b}`))
  vite.stderr?.on("data", (b) => process.stderr.write(`[vite] ${b}`))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        if (vite.killed) return resolve()
        vite.once("exit", () => resolve())
        vite.kill("SIGTERM")
        setTimeout(() => { if (!vite.killed) vite.kill("SIGKILL"); resolve() }, 5_000)
      }),
  )

  await waitForUrl(`http://127.0.0.1:${VITE_PORT}/`, 30_000)

  // 8. Hand off to Playwright. Forward extra CLI args after `--`.
  const playwrightArgs = ["playwright", "test", "--config", "e2e/config/playwright.config.web.ts"]
  const extra = process.argv.slice(2)
  const dashDashIdx = extra.indexOf("--")
  if (dashDashIdx >= 0) playwrightArgs.push(...extra.slice(dashDashIdx + 1))
  console.log(`[e2e-up] running: npx ${playwrightArgs.join(" ")}`)
  // Pass the local backend URLs through to the Playwright child so test
  // helpers (seed.ts, auth.ts, AI completion spec) can read them via
  // process.env. .env.test.local handles the Vite/browser side; this
  // handles the test-runner/node side.
  const pw = spawn("npx", playwrightArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_FRONTIER_BASE: `http://127.0.0.1:${FRONTIER_PORT}`,
      VITE_SYNC_WORKER_HOST: `127.0.0.1:${SYNC_WORKER_PORT}`,
      VITE_LLM_BASE_URL: mockLLM.baseUrl,
    },
  })
  pw.on("exit", (code) => { void shutdown(code ?? 1) })
}

main().catch((e) => {
  console.error("[e2e-up] fatal:", e)
  void shutdown(1)
})
