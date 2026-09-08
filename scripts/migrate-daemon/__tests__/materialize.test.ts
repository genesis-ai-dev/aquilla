// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import process from "node:process"
import os from "node:os"
import path from "node:path"
import { DaemonDb, type ProjectRow, type JobRow } from "../db"
import { readPlan } from "../plan"
import { materialize, CONTENT_LOGIC_VERSION, type MaterializeDeps } from "../stages/materialize"

const FIX = path.resolve(__dirname, "../../../tests/fixtures/codex-editor")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mat-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function makeProjectDir(stems: string[], opts: { comments?: boolean } = {}): string {
  const dir = path.join(root, `repo-${stems.length}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(dir, "files/target"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".project/sourceTexts"), { recursive: true })
  const codex = fs.readFileSync(path.join(FIX, "sample.codex"), "utf8")
  const source = fs.readFileSync(path.join(FIX, "sample.source"), "utf8")
  for (const stem of stems) {
    fs.writeFileSync(path.join(dir, "files/target", `${stem}.codex`), codex)
    fs.writeFileSync(path.join(dir, ".project/sourceTexts", `${stem}.source`), source)
  }
  if (opts.comments) {
    fs.copyFileSync(path.join(FIX, "comments.json"), path.join(dir, ".project/comments.json"))
  }
  return dir
}

function seed(db: DaemonDb, gitlabId = 47, applied: string | null = null): ProjectRow {
  db.upsertProject({
    gitlab_id: gitlabId, aquilla_id: "11111111-1111-4111-8111-111111111111", name: "p",
    namespace: "grp", org_id: 1, team_id: null, owner_user_id: 9,
    last_activity_at: "2026-09-01T00:00:00Z",
  })
  if (applied) markApplied(db, gitlabId, applied)
  return db.getProject(gitlabId)!
}

const markApplied = (db: DaemonDb, id: number, sha: string) =>
  db.setProjectFields(id, { applied_sha: sha, content_logic: CONTENT_LOGIC_VERSION })
const ledgerAdd = (db: DaemonDb, id: number, ids: string[]) =>
  db.ledgerAppend(id, ids, { jobId: 1, chunkNo: 0, ms: 1, httpStatus: 200, attempt: 1 })

const job = (id = 1, project_id = 47): JobRow => ({
  id, project_id, kind: "content", sha: "deadbeef", stage: "fetched", attempts: 0,
  next_run_at: 0, created_at: 0, updated_at: 0, error: null, plan_path: null,
})

const deps = (db: DaemonDb): MaterializeDeps => ({
  db, syncBase: "http://sync.invalid", syncSecret: "s",
  plansDir: path.join(root, "plans"), gitlabToken: "", now: () => 1_700_000_000_000,
})

describe("materialize", () => {
  const gc = (globalThis as { gc?: () => void }).gc

  it("writes an NDJSON plan of uuid-keyed events for a fresh project", async () => {
    const db = new DaemonDb(":memory:")
    const project = seed(db)
    const dir = makeProjectDir(["GEN 1"], { comments: true })
    const r = await materialize(deps(db), { job: job(), project, dir, httpUrlToRepo: "https://git/x.git" })

    expect(fs.existsSync(r.planPath)).toBe(true)
    expect(r.lines).toBeGreaterThan(0)
    expect(r.files).toBe(1)
    expect(r.changedFiles).toBe(1)
    expect(r.fileHashes.map((f) => f.path)).toContain("GEN 1")
    const lines = []
    for await (const b of readPlan(r.planPath, 100)) lines.push(...b)
    expect(lines).toHaveLength(r.lines)
    for (const l of lines) {
      expect(l.event.id).toMatch(UUID)
      expect(l.id).toBe(l.event.id)
      expect(l.hash).toMatch(/^[0-9a-f]{64}$/)
    }
    db.close()
  })

  it("skips an unchanged file once its hash and the ledger are recorded", async () => {
    const db = new DaemonDb(":memory:")
    const dir = makeProjectDir(["GEN 1"])
    const first = await materialize(deps(db), { job: job(), project: seed(db), dir, httpUrlToRepo: "https://git/x.git" })
    // Simulate a successful push: ledger + file hashes persisted, sha applied.
    const ids: string[] = []
    for await (const b of readPlan(first.planPath, 100)) ids.push(...b.map((l) => l.event.id))
    ledgerAdd(db, 47, ids)
    db.setFileHashes(47, first.fileHashes)
    markApplied(db, 47, "deadbeef")

    const second = await materialize(deps(db), { job: job(2), project: db.getProject(47)!, dir, httpUrlToRepo: "https://git/x.git" })
    expect(second.changedFiles).toBe(0)
    expect(second.lines).toBe(0)
    expect(second.files).toBe(1)
    // The cast still reflects the whole project, unchanged files included.
    expect(second.castHash).toBe(first.castHash)
    db.close()
  })

  it("re-materializes a file whose bytes changed", async () => {
    const db = new DaemonDb(":memory:")
    const dir = makeProjectDir(["GEN 1"])
    const first = await materialize(deps(db), { job: job(), project: seed(db), dir, httpUrlToRepo: "https://git/x.git" })
    const ids: string[] = []
    for await (const b of readPlan(first.planPath, 100)) ids.push(...b.map((l) => l.event.id))
    ledgerAdd(db, 47, ids)
    db.setFileHashes(47, first.fileHashes)
    markApplied(db, 47, "deadbeef")

    // A non-empty ledger arms the orphan pass, which reads the projection over
    // HTTP; stub it with an empty projection (nothing to retract or re-anchor).
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ cells: [], lastCellId: "", more: false }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch

    // A real edit appends to `metadata.edits[]` — event ids are keyed by edit
    // index, so that (not the bare `value`) is what makes new events.
    const f = path.join(dir, "files/target/GEN 1.codex")
    type Edit = { author: string; timestamp: number; type: string; editMap: string[]; value: string }
    const nb = JSON.parse(fs.readFileSync(f, "utf8")) as
      { cells: { value: string; metadata: { edits: Edit[] } }[] }
    const cell = nb.cells[0]
    cell.value = "<p>changed by the test</p>"
    cell.metadata.edits.push({
      author: "bob", timestamp: 1_700_000_100_000, type: "user-edit",
      editMap: ["value"], value: cell.value,
    })
    fs.writeFileSync(f, JSON.stringify(nb))

    const second = await materialize(deps(db), { job: job(2), project: db.getProject(47)!, dir, httpUrlToRepo: "https://git/x.git" })
      .finally(() => { globalThis.fetch = realFetch })
    expect(second.changedFiles).toBe(1)
    expect(second.lines).toBeGreaterThan(0)
    db.close()
  })

  it("force ignores the unchanged-hash skip", async () => {
    const db = new DaemonDb(":memory:")
    const dir = makeProjectDir(["GEN 1"])
    const first = await materialize(deps(db), { job: job(), project: seed(db), dir, httpUrlToRepo: "https://git/x.git" })
    db.setFileHashes(47, first.fileHashes)
    markApplied(db, 47, "deadbeef")
    const forced = await materialize(deps(db), { job: job(2), project: db.getProject(47)!, dir, httpUrlToRepo: "https://git/x.git", force: true })
    expect(forced.changedFiles).toBe(1)
    expect(forced.lines).toBe(first.lines)
    db.close()
  })

  it("CONTENT_LOGIC_VERSION matches scripts/migrate-all.ts", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../migrate-all.ts"), "utf8")
    const m = src.match(/const CONTENT_LOGIC_VERSION = (\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(CONTENT_LOGIC_VERSION)
  })

  it.skipIf(!gc)("stays under 300 MB of heap on a 200-file project", async () => {
    const db = new DaemonDb(":memory:")
    const stems = Array.from({ length: 200 }, (_, i) => `BK ${i + 1}`)
    const dir = makeProjectDir(stems)
    const r = await materialize(deps(db), { job: job(), project: seed(db), dir, httpUrlToRepo: "https://git/x.git" })
    expect(r.files).toBe(200)
    expect(r.changedFiles).toBe(200)
    expect(r.lines).toBeGreaterThan(200)
    expect(gc, "run with NODE_OPTIONS=--expose-gc (pnpm test:daemon)").toBeDefined()
    gc!()
    const heapUsed = process.memoryUsage().heapUsed
    console.log(`heap after gc: ${(heapUsed / 1024 / 1024).toFixed(1)} MB`)
    expect(heapUsed).toBeLessThan(300 * 1024 * 1024)
    db.close()
  }, 120_000)
})
