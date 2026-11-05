/**
 * Rebuilds the offline state db from a real eventlog, the way the desktop
 * app's leader does after a schema change, and reports how long it took.
 *
 *   pnpm offline:replay-check <eventlog.db> [--cuts N]
 *
 * Runs the rebuild twice — replaying every event, then with the replay-skip
 * rules (src/lib/offline/replay-skip.ts) — and fails unless both produce the
 * same rows in every app table and the rebuilt state db's head matches the
 * eventlog's (the leader rebuilds again on every boot when they differ).
 * Uses LiveStore's own recreateDb with our
 * patches applied, on in-memory SQLite. `--cuts N` also checks the eventlog
 * as it stood at N points in its history (truncated there, with the
 * confirmed head moved back to match), which covers outbox rows still
 * pending, projects mid-download, and so on.
 *
 * To get an eventlog from the desktop app: quit it, then find the file in
 * ~/Library/WebKit/<app>/WebsiteData/Default/<hash>/<hash>/FileSystem/
 * livestore-aquilla-offline@6/ whose header names `/eventlog.db`, and strip
 * the 4096-byte pool header: `tail -c +4097 <file> > eventlog.db`.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import type { BootStatus } from "@livestore/common"
import { makeMaterializeEvent, recreateDb } from "@livestore/common/leader-thread"
import { Effect, Queue } from "@livestore/utils/effect"
import { schema } from "../src/lib/offline/schema"
import { planReplaySkip } from "../src/lib/offline/replay-skip"

const file = process.argv[2]
const flag = (name: string): number | undefined => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : Number(process.argv[i + 1])
}
const cuts = flag("--cuts") ?? 0
const cutAt = flag("--cut-at")
if (!file || !Number.isInteger(cuts) || cuts < 0) {
  console.error("usage: pnpm offline:replay-check <eventlog.db> [--cuts N]")
  process.exit(2)
}

// @livestore/sqlite-wasm isn't a direct dependency; take the (patched) copy LiveStore uses.
const sqliteWasmDir = path.join(realpathSync(path.join(process.cwd(), "node_modules/@livestore/adapter-web")), "..", "sqlite-wasm")
const { loadSqlite3Wasm } = await import(path.join(sqliteWasmDir, "dist/load-wasm/mod.node.js"))
const { makeInMemoryDb } = await import(path.join(sqliteWasmDir, "dist/in-memory-vfs.js"))
const { makeSqliteDb } = await import(path.join(sqliteWasmDir, "dist/make-sqlite-db.js"))
const sqlite3 = await loadSqlite3Wasm()

const makeDb = () => {
  const { dbPointer, vfs } = makeInMemoryDb(sqlite3)
  return makeSqliteDb({
    sqlite3,
    metadata: { _tag: "in-memory", vfs, dbPointer, persistenceInfo: { fileName: ":memory:" }, deleteDb: () => {}, configureDb: () => {} },
  })
}

const eventlogBytes = new Uint8Array(readFileSync(file))
const APP_TABLES = ["cells", "files", "projects", "sync_cursors", "offline_projects", "event_queue"]

async function rebuild(withSkip: boolean, cutAtGlobal?: number) {
  const hookHolder = globalThis as { __livestoreRehydrateSkip?: typeof planReplaySkip }
  let skippedCount = 0
  if (withSkip) {
    hookHolder.__livestoreRehydrateSkip = (eventlog) => {
      const skip = planReplaySkip(eventlog)
      return skip && ((row) => (skip(row) ? (skippedCount++, true) : false))
    }
  } else delete hookHolder.__livestoreRehydrateSkip

  const dbEventlog = makeDb()
  dbEventlog.import(eventlogBytes)
  if (cutAtGlobal !== undefined) {
    dbEventlog.execute(`DELETE FROM eventlog WHERE seqNumGlobal > ${cutAtGlobal}`)
    dbEventlog.execute(`UPDATE __livestore_sync_status SET head = ${cutAtGlobal}`)
  }
  const dbState = makeDb()
  const started = performance.now()
  await Effect.gen(function* () {
    const bootStatusQueue = yield* Queue.unbounded<BootStatus>()
    const materializeEvent = yield* makeMaterializeEvent({ schema, dbState, dbEventlog })
    yield* recreateDb({ dbState, dbEventlog, schema, bootStatusQueue, materializeEvent })
  }).pipe(Effect.scoped, Effect.runPromise)
  const ms = performance.now() - started

  const dump: Record<string, string[]> = {}
  for (const table of APP_TABLES) {
    dump[table] = dbState.select(`SELECT * FROM ${table}`).map((row: Record<string, unknown>) => JSON.stringify(row)).sort()
  }
  const total = Number(dbEventlog.select("SELECT COUNT(*) AS n FROM eventlog")[0].n)
  // The leader's own head check (make-leader-thread-layer.js, our patch): newest changeset row vs newest event.
  const headOf = (db: ReturnType<typeof makeDb>, table: string): string => {
    const row = db.select(`SELECT seqNumGlobal AS g, seqNumClient AS c FROM ${table} ORDER BY seqNumGlobal DESC, seqNumClient DESC LIMIT 1`)[0]
    return row === undefined ? "none" : `e${row.g}.${row.c}`
  }
  const stateHead = headOf(dbState, "__livestore_session_changeset")
  const eventlogHead = headOf(dbEventlog, "eventlog")
  dbState.close()
  dbEventlog.close()
  return { ms, dump, replayed: total - skippedCount, total, stateHead, eventlogHead }
}

async function check(label: string, cutAtGlobal?: number): Promise<boolean> {
  const full = await rebuild(false, cutAtGlobal)
  const skipped = await rebuild(true, cutAtGlobal)
  let same = true
  for (const table of APP_TABLES) {
    const a = full.dump[table]
    const b = skipped.dump[table]
    const equal = a.length === b.length && a.every((row, i) => row === b[i])
    if (!equal) same = false
    if (!equal || cutAtGlobal === undefined) {
      console.log(`${equal ? "same" : "DIFFERENT"}  ${table}: ${a.length} rows (full) / ${b.length} rows (with skip)`)
    }
  }
  for (const [name, run] of [["full", full], ["with skip", skipped]] as const) {
    if (run.stateHead !== run.eventlogHead) {
      same = false
      console.log(`DIFFERENT  state head (${name}): ${run.stateHead}, eventlog head ${run.eventlogHead}`)
    }
  }
  const counts = APP_TABLES.map((t) => `${t} ${full.dump[t].length}`).join(", ")
  console.log(`${same ? "ok  " : "FAIL"} ${label}: replayed ${skipped.replayed} of ${skipped.total} events (${Math.round(skipped.ms)} ms; full replay ${Math.round(full.ms)} ms) — ${counts}`)
  return same
}

// One check per process: sqlite-wasm's in-memory VFS keeps its buffers after
// a db closes, so a run of rebuilds in one process runs out of WASM memory.
if (cutAt !== undefined) process.exit((await check(`cut at e${cutAt}`, cutAt)) ? 0 : 1)

let allSame = await check("whole eventlog")
if (cuts > 0) {
  const probe = makeDb()
  probe.import(eventlogBytes)
  const maxGlobal = Number(probe.select("SELECT MAX(seqNumGlobal) AS g FROM eventlog")[0].g)
  probe.close()
  for (let i = 1; i <= cuts; i++) {
    const at = Math.floor((maxGlobal * i) / (cuts + 1))
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1], file, "--cut-at", String(at)], {
      stdio: "inherit",
    })
    if (child.status !== 0) allSame = false
  }
}
process.exit(allSame ? 0 : 1)
