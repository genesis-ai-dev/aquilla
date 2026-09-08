// @vitest-environment node
import { describe, it, expect } from "vitest"
import { DaemonDb, JOB_BACKOFF_MS } from "../db"

const proj = (db: DaemonDb, id = 47) =>
  db.upsertProject({ gitlab_id: id, aquilla_id: `aq-${id}`, name: `p${id}`, namespace: "grp", org_id: 1, team_id: null, owner_user_id: 9, last_activity_at: "2026-09-01T00:00:00Z" })

describe("DaemonDb jobs", () => {
  it("enqueue is unique per (project, kind) while unfinished and a newer sha supersedes", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const a = db.enqueue(47, "content", "sha1")
    const b = db.enqueue(47, "content", "sha2")
    expect(b.id).toBe(a.id)
    expect(db.getJob(a.id)?.sha).toBe("sha2")
    expect(db.listJobs("detected")).toHaveLength(1)
  })
  it("holds a failed job back by its backoff while siblings stay ready", () => {
    // The scheduler picks ready jobs itself (listJobs + next_run_at filter);
    // what the db owes it is a correct next_run_at.
    const db = new DaemonDb(":memory:")
    proj(db, 1); proj(db, 2)
    const first = db.enqueue(1, "content", "s")
    db.enqueue(2, "content", "s")
    db.fail(first.id, "boom", 1000)
    expect(db.getJob(first.id)?.next_run_at).toBe(1000 + JOB_BACKOFF_MS[0])
    const ready = db.listJobs("detected").filter((j) => j.next_run_at <= 1000)
    expect(ready.map((j) => j.project_id)).toEqual([2])
  })
  it("fail escalates backoff and never drops the job", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const j = db.enqueue(47, "content", "s")
    for (let i = 0; i < 7; i++) db.fail(j.id, `e${i}`, 0)
    const row = db.getJob(j.id)!
    expect(row.attempts).toBe(7)
    expect(row.next_run_at).toBe(JOB_BACKOFF_MS[JOB_BACKOFF_MS.length - 1])
    expect(row.stage).not.toBe("done")
    expect(row.error).toBe("e6")
  })
  it("advance moves stage and stores plan_path", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const j = db.enqueue(47, "content", "s")
    db.advance(j.id, "planned", { plan_path: "/x/47/s.ndjson" })
    expect(db.getJob(j.id)).toMatchObject({ stage: "planned", plan_path: "/x/47/s.ndjson" })
  })
})

describe("DaemonDb ledger", () => {
  it("filterNew excludes applied ids; append is atomic with the push log", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const j = db.enqueue(47, "content", "s")
    db.ledgerAppend(47, ["a", "b"], { jobId: j.id, chunkNo: 0, ms: 12, httpStatus: 200, attempt: 1 })
    expect(db.ledgerFilterNew(47, ["a", "b", "c"])).toEqual(["c"])
    expect(db.ledgerCount(47)).toBe(2)
    db.ledgerReplace(47, ["z"])
    expect(db.ledgerCount(47)).toBe(1)
    expect(db.ledgerHas(47, "z")).toBe(true)
  })
  it("file hashes and kv round-trip", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    db.setFileHashes(47, [{ path: "files/target/a.codex", hash: "h1" }])
    expect(db.fileHash(47, "files/target/a.codex")).toBe("h1")
    db.kvSet("inbox_cursor", "k1")
    expect(db.kvGet("inbox_cursor")).toBe("k1")
  })
  it("setFileHashes rolls back on error and doesn't wedge connection", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    // Try to insert a null hash (invalid for NOT NULL column) as second entry
    expect(() => {
      db.setFileHashes(47, [
        { path: "files/target/good.codex", hash: "h1" },
        { path: "files/target/bad.codex", hash: null as unknown as string },
      ])
    }).toThrow()
    // Connection is not wedged: kv operations work
    db.kvSet("inbox_cursor", "k1")
    expect(db.kvGet("inbox_cursor")).toBe("k1")
    // No partial rows written: first entry was rolled back
    expect(db.fileHash(47, "files/target/good.codex")).toBeUndefined()
  })
})
