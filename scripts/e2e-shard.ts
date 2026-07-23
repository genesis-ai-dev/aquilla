// Parallel e2e runner. Launches N fully-isolated e2e-up stacks at once, each
// owning its own ports + Postgres DB + build dir, and each running a Playwright
// `--shard=i/N` slice. Wall-clock ≈ (serial time / N) + one build.
//
//   npx tsx scripts/e2e-shard.ts          # all smoke specs, default shard count
//   npx tsx scripts/e2e-shard.ts 4        # 4 shards
//   npx tsx scripts/e2e-shard.ts 3 -- smoke.spec   # forward args to playwright
//
// Each stack is internally serial (Playwright workers:1, the backend reset is
// global within a DB); isolation comes from giving every shard its own backend,
// not from parallelizing inside one. Output is line-prefixed [sN] per shard.

import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { killChildTree } from "./lib/spawn-worker"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

// Args: [N] then optional [-- <forwarded playwright args>].
// `pnpm run test:e2e:shard -- 3 -- smoke.spec` includes a leading separator
// before our own args; accept it because it is an easy muscle-memory mistake.
const rawArgv = process.argv.slice(2)
const argv = rawArgv[0] === "--" && /^\d+$/.test(rawArgv[1] ?? "") ? rawArgv.slice(1) : rawArgv
const dashDash = argv.indexOf("--")
const ownArgs = dashDash >= 0 ? argv.slice(0, dashDash) : argv
const forwarded = dashDash >= 0 ? argv.slice(dashDash + 1) : []

const N = (() => {
  const fromArg = ownArgs.find((a) => /^\d+$/.test(a))
  const raw = fromArg ?? process.env.E2E_SHARDS ?? "3"
  const n = parseInt(raw, 10)
  // Cap at 8 — beyond that the shared Postgres + N concurrent builds thrash.
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 3, 8))
})()

// Stagger starts so N `vite build`s and `CREATE DATABASE`s don't all fire at the
// same instant (CPU spike / transient PG contention).
const STAGGER_MS = 2500
const COLORS = [36, 32, 33, 35, 34, 31, 96, 92] // cyan, green, yellow, …
const WATCHDOG_INTERVAL_MS = 15_000
const QUIET_WARNING_MS = 30_000
const STALL_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.E2E_STALL_TIMEOUT_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 60_000
})()

interface Shard {
  idx: number
  proc: ChildProcess
  code: number | null
  buf: { out: string; err: string }
  startedAt: number
  lastOutputAt: number
  lastLine: string
  terminating: boolean
  done: Promise<void>
}

const shards: Shard[] = []

function emit(idx: number, stream: NodeJS.WriteStream, key: "out" | "err", chunk: Buffer, shard: Shard): void {
  shard.buf[key] += chunk.toString()
  const lines = shard.buf[key].split("\n")
  shard.buf[key] = lines.pop() ?? ""
  const color = COLORS[(idx - 1) % COLORS.length]
  for (const line of lines) {
    shard.lastOutputAt = Date.now()
    if (line.trim()) shard.lastLine = line.trim()
    stream.write(`\x1b[${color}m[s${idx}]\x1b[0m ${line}\n`)
  }
}

function startShard(idx: number): Shard {
  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  const proc = spawn(
    "npx",
    ["tsx", "scripts/e2e-up.ts", ...(forwarded.length ? ["--", ...forwarded] : [])],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, E2E_SHARD: `${idx}/${N}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const now = Date.now()
  const shard: Shard = {
    idx,
    proc,
    code: null,
    buf: { out: "", err: "" },
    startedAt: now,
    lastOutputAt: now,
    lastLine: "process started",
    terminating: false,
    done,
  }
  proc.stdout?.on("data", (c: Buffer) => emit(idx, process.stdout, "out", c, shard))
  proc.stderr?.on("data", (c: Buffer) => emit(idx, process.stderr, "err", c, shard))
  proc.on("exit", (code) => { shard.code = code ?? 1; resolveDone() })
  proc.on("error", (error) => {
    shard.lastLine = `spawn failed: ${error.message}`
    shard.code = 1
    resolveDone()
  })
  return shard
}

function terminateStalledShard(shard: Shard): void {
  if (shard.terminating || shard.code !== null) return
  shard.terminating = true
  shard.code = 1
  console.error(
    `[e2e-shard] s${shard.idx} produced no output for ${Math.round(STALL_TIMEOUT_MS / 1_000)}s; ` +
      `terminating pid ${shard.proc.pid ?? "unknown"}. Last output: ${shard.lastLine}`,
  )
  // Kill the npx/tsx wrapper and all worker/build/browser descendants. Killing
  // only the wrapper can orphan wrangler or Vite and poison the next run's
  // ports, which makes a detected stall look like a new unrelated failure.
  void killChildTree(shard.proc)
}

function killAll(_sig: NodeJS.Signals): void {
  for (const s of shards) {
    void killChildTree(s.proc)
  }
}
process.on("SIGINT", () => killAll("SIGINT"))
process.on("SIGTERM", () => killAll("SIGTERM"))

async function main(): Promise<void> {
  console.log(`[e2e-shard] launching ${N} isolated stack(s) · forwarding: ${forwarded.join(" ") || "<all specs>"}`)
  for (let i = 1; i <= N; i++) {
    shards.push(startShard(i))
    if (i < N) await new Promise((r) => setTimeout(r, STAGGER_MS))
  }

  const watchdog = setInterval(() => {
    const now = Date.now()
    for (const shard of shards) {
      if (shard.code !== null) continue
      const quietMs = now - shard.lastOutputAt
      if (quietMs >= STALL_TIMEOUT_MS) {
        terminateStalledShard(shard)
      } else if (quietMs >= QUIET_WARNING_MS) {
        const runtime = Math.round((now - shard.startedAt) / 1_000)
        console.warn(
          `[e2e-shard] s${shard.idx} still running (${runtime}s total, ` +
            `${Math.round(quietMs / 1_000)}s quiet). Last output: ${shard.lastLine}`,
        )
      }
    }
  }, WATCHDOG_INTERVAL_MS)
  watchdog.unref()

  await Promise.all(shards.map((s) => s.done))
  clearInterval(watchdog)

  // Flush any trailing partial lines.
  for (const s of shards) {
    if (s.buf.out) process.stdout.write(`[s${s.idx}] ${s.buf.out}\n`)
    if (s.buf.err) process.stderr.write(`[s${s.idx}] ${s.buf.err}\n`)
  }

  const failed = shards.filter((s) => (s.code ?? 1) !== 0)
  console.log("")
  console.log(`[e2e-shard] ${shards.length - failed.length}/${shards.length} shard(s) passed`)
  for (const s of shards) console.log(`  s${s.idx}: exit ${s.code}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error("[e2e-shard] fatal:", e)
  killAll("SIGTERM")
  process.exit(1)
})
