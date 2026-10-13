import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  acquireE2eSlotLock,
  DEFAULT_E2E_LOCK_WAIT_SECONDS,
  E2E_LOCK_OWNER_FILE,
  e2eSlotLockPath,
  type E2eLockRecord,
} from "./e2e-lock"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "../..")
const LOCK_MODULE = path.join(HERE, "e2e-lock.ts")

const roots: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
  }
  children.length = 0
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aquilla-e2e-lock-"))
  roots.push(root)
  return root
}

function readOwner(lockPath: string): E2eLockRecord {
  return JSON.parse(readFileSync(path.join(lockPath, E2E_LOCK_OWNER_FILE), "utf8")) as E2eLockRecord
}

function plant(
  root: string,
  slot: number,
  record: Partial<E2eLockRecord> & Pick<E2eLockRecord, "pid">,
): string {
  const lockPath = e2eSlotLockPath(slot, root)
  mkdirSync(lockPath)
  const owner: E2eLockRecord = {
    cwd: "/stale",
    startedAt: "2020-01-01T00:00:00.000Z",
    command: "stale-run",
    token: "stale-token",
    ...record,
  }
  writeFileSync(path.join(lockPath, E2E_LOCK_OWNER_FILE), JSON.stringify(owner))
  return lockPath
}

async function deadPid(): Promise<number> {
  const child = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
  children.push(child)
  const pid = child.pid
  if (!pid) throw new Error("sleeper did not start")
  child.kill("SIGKILL")
  await new Promise((resolve) => child.once("exit", resolve))
  if (osPidAlive(pid)) throw new Error(`pid ${pid} was reused or is still alive`)
  return pid
}

/** Real Node: ESRCH means the pid is gone, EPERM means it exists but isn't ours. */
function osPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

describe("e2e slot lock", () => {
  it("defaults the wait to 30 minutes", () => {
    expect(DEFAULT_E2E_LOCK_WAIT_SECONDS).toBe(30 * 60)
  })

  it("acquires when the slot is free", async () => {
    const root = await tempRoot()
    const handle = await acquireE2eSlotLock({
      slot: 0,
      root,
      pid: 7,
      cwd: "/repo",
      command: "pnpm test:e2e",
      startedAt: "2026-10-02T12:00:00.000Z",
      env: {},
      isAlive: () => false,
    })

    expect(handle.path).toBe(e2eSlotLockPath(0, root))
    expect(readOwner(handle.path)).toMatchObject({
      pid: 7,
      cwd: "/repo",
      command: "pnpm test:e2e",
      startedAt: "2026-10-02T12:00:00.000Z",
    })
    handle.release()
    expect(existsSync(handle.path)).toBe(false)
    handle.release()
    expect(existsSync(handle.path)).toBe(false)
  })

  it("different slots do not contend", async () => {
    const root = await tempRoot()
    const first = await acquireE2eSlotLock({
      slot: 0, root, pid: 1, cwd: "/a", command: "a", env: {}, isAlive: () => true,
    })
    const second = await acquireE2eSlotLock({
      slot: 1, root, pid: 2, cwd: "/b", command: "b", env: {}, isAlive: () => true,
    })
    expect(readOwner(first.path).pid).toBe(1)
    expect(readOwner(second.path).pid).toBe(2)
    first.release()
    expect(readOwner(second.path).pid).toBe(2)
    second.release()
  })

  it("a second acquire waits while the holder is alive and proceeds after release", async () => {
    const root = await tempRoot()
    const logs: string[] = []
    const first = await acquireE2eSlotLock({
      slot: 4,
      root,
      pid: 4242,
      cwd: "/work/first",
      command: "first-run",
      startedAt: "2026-10-02T12:00:00.000Z",
      env: {},
      isAlive: (pid) => pid === 4242,
    })
    let resolved = false
    const second = acquireE2eSlotLock({
      slot: 4,
      root,
      pid: 4343,
      cwd: "/work/second",
      command: "second-run",
      env: {},
      isAlive: (pid) => pid === 4242 || pid === 4343,
      pollMs: 20,
      logEveryMs: 30_000,
      log: (line) => logs.push(line),
    }).then((handle) => {
      resolved = true
      return handle
    })

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(resolved).toBe(false)
    expect(logs).toEqual([
      "[e2e-up] waiting for the e2e run in /work/first (pid 4242, started 2026-10-02T12:00:00.000Z) to finish…",
    ])

    first.release()
    const handle = await second
    expect(readOwner(handle.path).pid).toBe(4343)
    handle.release()
  })

  it("logs the wait again on the interval and then tells the user how to clear the lock", async () => {
    const root = await tempRoot()
    await acquireE2eSlotLock({
      slot: 0,
      root,
      pid: 10,
      cwd: "/holder",
      command: "pnpm test:e2e",
      startedAt: "2026-10-02T00:00:00.000Z",
      env: {},
      isAlive: () => true,
    })
    let clock = 1_000
    const logs: string[] = []
    const waiting = "[e2e-up] waiting for the e2e run in /holder (pid 10, started 2026-10-02T00:00:00.000Z) to finish…"

    const attempt = acquireE2eSlotLock({
      slot: 0,
      root,
      pid: 11,
      cwd: "/waiter",
      command: "waiter",
      env: {},
      isAlive: (pid) => pid === 10,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      waitSeconds: 60,
      pollMs: 2_000,
      logEveryMs: 30_000,
      log: (line) => logs.push(line),
    })

    await expect(attempt).rejects.toThrow(
      /gave up after 60s[\s\S]*ps -p 10 -o pid,etime,command[\s\S]*Clear a stale lock with: rm -rf[\s\S]*E2E_LOCK=off/,
    )
    expect(logs[0]).toBe(waiting)
    expect(new Set(logs)).toEqual(new Set([waiting]))
    expect(logs.length).toBeGreaterThan(1)
    expect(logs.length).toBeLessThan(10)
  })

  it("takes over a lock whose pid is dead", async () => {
    const root = await tempRoot()
    const pid = await deadPid()
    const lockPath = plant(root, 2, { pid, cwd: "/old-worktree", command: "old" })

    const handle = await acquireE2eSlotLock({
      slot: 2,
      root,
      pid: 424242,
      cwd: "/new-worktree",
      command: "next",
      env: {},
      isAlive: osPidAlive,
    })
    const owner = readOwner(lockPath)
    expect(owner.pid).toBe(424242)
    expect(owner.cwd).toBe("/new-worktree")
    expect(owner.command).toBe("next")
    expect(owner.token).not.toBe("stale-token")
    handle.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it("takes over a lock directory with no readable owner", async () => {
    const root = await tempRoot()
    const lockPath = e2eSlotLockPath(3, root)
    mkdirSync(lockPath)
    const handle = await acquireE2eSlotLock({
      slot: 3,
      root,
      pid: 8,
      cwd: "/new",
      command: "new",
      env: {},
      isAlive: () => false,
    })
    expect(readOwner(handle.path).pid).toBe(8)
    handle.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it("release removes only our own lock", async () => {
    const root = await tempRoot()
    const ours = await acquireE2eSlotLock({
      slot: 0,
      root,
      pid: 10,
      cwd: "/ours",
      command: "ours",
      startedAt: "t0",
      env: {},
      isAlive: () => true,
    })
    rmSync(ours.path, { recursive: true, force: true })
    const successor = plant(root, 0, {
      pid: 11,
      cwd: "/theirs",
      command: "theirs",
      token: "successor-token",
      startedAt: "t1",
    })
    ours.release()
    expect(readOwner(successor)).toMatchObject({ pid: 11, token: "successor-token", cwd: "/theirs" })
  })

  it("E2E_LOCK=off does not create a lock or wait on one", async () => {
    const root = await tempRoot()
    const held = await acquireE2eSlotLock({
      slot: 0, root, pid: 5, cwd: "/held", command: "held", env: {}, isAlive: () => true,
    })
    const bypass = await acquireE2eSlotLock({
      slot: 0,
      root,
      pid: 6,
      cwd: "/bypass",
      command: "bypass",
      env: { E2E_LOCK: "off" },
    })
    expect(bypass.path).toBe("")
    expect(readOwner(held.path).pid).toBe(5)
    bypass.release()
    expect(readOwner(held.path).pid).toBe(5)
    held.release()
  })

  it("two concurrent stale takeovers produce exactly one winner", async () => {
    const root = await tempRoot()
    const runner = path.join(root, "race-runner.mts")
    writeFileSync(runner, raceRunnerSource())

    for (let round = 0; round < 5; round++) {
      const dead = await deadPid()
      plant(root, round, { pid: dead, cwd: "/dead", command: "dead" })
      const racers = [startRacer(runner, root, round), startRacer(runner, root, round)]
      try {
        await waitFor(() => {
          const won = acquiredPids(racers)
          if (won.length > 1) {
            throw new Error(`round ${round}: both racers acquired\n${dump(racers)}`)
          }
          const waiting = racers.some((racer) => racer.output().includes("waiting for the e2e run"))
          return won.length === 1 && waiting
        }, 20_000, () => `round ${round} did not settle\n${dump(racers)}`)

        const [winnerPid] = acquiredPids(racers)
        expect(readOwner(e2eSlotLockPath(round, root)).pid).toBe(winnerPid)
        const winner = racers.find((racer) => racer.pid === winnerPid)
        if (!winner) throw new Error(`winner pid ${winnerPid} is not a child`)
        signalRelease(winner)

        await waitFor(
          () => acquiredPids(racers).length === 2,
          20_000,
          () => `round ${round}: waiter did not acquire after release\n${dump(racers)}`,
        )
        const waiter = racers.find((racer) => racer.pid !== winnerPid)
        expect(waiter?.output()).toContain(
          `[e2e-up] waiting for the e2e run in ${REPO_ROOT} (pid ${winnerPid}, started`,
        )
        if (waiter) signalRelease(waiter)
        await waitFor(
          () => racers.every((racer) => racer.output().includes("RELEASED")),
          10_000,
          () => `round ${round}: racers did not release\n${dump(racers)}`,
        )
      } finally {
        for (const racer of racers) {
          if (racer.child.exitCode === null) racer.child.kill("SIGKILL")
        }
      }
    }
  }, 120_000)

  it("e2e-up acquires the slot lock before freeing ports or resetting Postgres", () => {
    const source = readFileSync(path.join(REPO_ROOT, "scripts/e2e-up.ts"), "utf8")
    const main = source.slice(source.indexOf("async function main"))
    const acquireAt = main.indexOf("acquireE2eSlotLock")
    const freeAt = main.indexOf("await freePort(port)")
    const resetAt = main.indexOf("resetE2ePostgres()")
    expect(acquireAt).toBeGreaterThanOrEqual(0)
    expect(acquireAt).toBeLessThan(freeAt)
    expect(freeAt).toBeLessThan(resetAt)

    const shutdown = source.slice(
      source.indexOf("async function shutdown"),
      source.indexOf("async function waitForUrl"),
    )
    expect(shutdown).toContain("if (portsOwned)")
    const freeInShutdown = shutdown.indexOf("await freePort(port)")
    expect(freeInShutdown).toBeGreaterThanOrEqual(0)
    expect(freeInShutdown).toBeLessThan(shutdown.lastIndexOf("process.exit"))
    expect(source).toMatch(/process\.on\("exit", \(\) => \{[\s\S]*slotLock\?\.release\(\)/)
    expect(source).toContain("E2E_LOCK=off")
    expect(source).toContain("E2E_LOCK_WAIT_SECONDS")
    expect(source).toMatch(/if \(portsOwned\) void shutdown\(1\)/)
  })
})

interface Racer {
  pid: number
  child: ChildProcess
  output: () => string
  stderr: () => string
}

function startRacer(runner: string, root: string, slot: number): Racer {
  let out = ""
  let err = ""
  // `--import tsx` runs the runner in this process. The tsx CLI re-execs, so
  // its pid would not match the lock and stdin would not reach the waiter.
  const child = spawn("node", ["--import", "tsx", runner, root, String(slot)], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  })
  children.push(child)
  child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString() })
  child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString() })
  if (!child.pid) throw new Error("racer failed to start")
  return { pid: child.pid, child, output: () => out, stderr: () => err }
}

function acquiredPids(racers: Racer[]): number[] {
  const pids: number[] = []
  for (const racer of racers) {
    const match = racer.output().match(/ACQUIRED (\d+)/)
    if (match?.[1]) pids.push(Number(match[1]))
  }
  return pids
}

function signalRelease(racer: Racer): void {
  try { racer.child.stdin?.write("release\n") } catch { /* already exited */ }
}

function dump(racers: Racer[]): string {
  return racers.map((racer) => `pid ${racer.pid}\nstdout:\n${racer.output()}\nstderr:\n${racer.stderr()}`).join("\n---\n")
}

async function waitFor(predicate: () => boolean, timeoutMs: number, detail: () => string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(detail())
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function raceRunnerSource(): string {
  return `
import fs from "node:fs"
import { acquireE2eSlotLock } from ${JSON.stringify(pathToFileURL(LOCK_MODULE).href)}

const root = process.argv[2]
const slot = Number(process.argv[3])
if (!root || !Number.isInteger(slot)) throw new Error("usage: race-runner <root> <slot>")
const handle = await acquireE2eSlotLock({
  slot,
  root,
  cwd: process.cwd(),
  command: "e2e-lock-race",
  pollMs: 20,
  logEveryMs: 1_000,
  env: {},
})
fs.writeSync(1, \`ACQUIRED \${process.pid}\\n\`)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for release")), 30_000)
  process.stdin.on("data", (chunk) => {
    if (String(chunk).includes("release")) {
      clearTimeout(timer)
      resolve(undefined)
    }
  })
})
handle.release()
fs.writeSync(1, \`RELEASED \${process.pid}\\n\`)
`
}
