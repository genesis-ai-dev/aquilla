// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import process from "node:process"
import os from "node:os"
import path from "node:path"
import { compareProject, main, type ParityLine } from "../parity"
import type { PlanLine } from "../plan"
import type { IngestEvent } from "../../../src/lib/migrate/types"

function ev(id: string, kind: string, fileId = "f1", cellId?: string): IngestEvent {
  return {
    id,
    kind,
    fileId,
    cellId,
    parentId: null,
    author: "legacy-import",
    clientTs: 1,
    payload: {},
  } as IngestEvent
}

/** Builds a slim `ParityLine` for `compareProject` tests. */
function line(
  id: string,
  kind: string,
  hash: string,
  fileId = "f1",
  _cellId?: string,
  reconcile?: true,
): ParityLine {
  const l: ParityLine = { id, kind, fileId, hash }
  if (reconcile) l.reconcile = true
  return l
}

/** Builds a full `PlanLine` for writing to an on-disk daemon plan file. */
function planLine(
  id: string,
  kind: string,
  hash: string,
  fileId = "f1",
  cellId?: string,
  reconcile?: true,
): PlanLine {
  const l: PlanLine = { id, event: ev(id, kind, fileId, cellId), hash }
  if (reconcile) l.reconcile = true
  return l
}

describe("compareProject", () => {
  it("reports all zero for equal sets", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: ParityLine[] = [line("a", "source.cell.create", "h1"), line("b", "source.cell.create", "h2")]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 0, order: 0 })
  })

  it("counts a changed hash", () => {
    const old = new Map([["a", { hash: "h1" }]])
    const plan: ParityLine[] = [line("a", "source.cell.create", "h1-different")]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 1, order: 0 })
  })

  it("counts an extra id present only in the plan", () => {
    const old = new Map([["a", { hash: "h1" }]])
    const plan: ParityLine[] = [line("a", "source.cell.create", "h1"), line("b", "source.cell.create", "h2")]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 1, changed: 0, order: 0 })
  })

  it("counts a missing id present only in old", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: ParityLine[] = [line("a", "source.cell.create", "h1")]
    expect(compareProject(old, plan)).toEqual({ missing: 1, extra: 0, changed: 0, order: 0 })
  })

  it("flags a tagged reconciliation event that lands before its file's last create", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: ParityLine[] = [
      line("a", "source.cell.delete", "h1", "f1", "c1", true), // reconciliation before the create — out of order
      line("b", "source.cell.create", "h2", "f1", "c1"),
    ]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 0, order: 1 })
  })

  it("does not flag a tagged reconciliation event that lands after its file's last create", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: ParityLine[] = [
      line("a", "source.cell.create", "h1", "f1", "c1"),
      line("b", "source.cell.delete", "h2", "f1", "c1", true),
    ]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 0, order: 0 })
  })

  it("does not flag an UNTAGGED cell.delete before a create — mapper events interleave freely", () => {
    // mapFilePairToEvents itself emits *.cell.delete interleaved with creates,
    // identically on migrate-all and the daemon; only reconcile-tagged lines
    // from computeOrphanRetractions are subject to the ordering invariant.
    // This is the AQU false-positive: an empty-ledger run emits no reconcile
    // lines at all, so order must stay 0.
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: ParityLine[] = [
      line("a", "source.cell.delete", "h1", "f1", "c1"), // untagged mapper delete, before the create
      line("b", "source.cell.create", "h2", "f1", "c1"),
    ]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 0, order: 0 })
  })
})

describe("main (CLI)", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-cli-"))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("exits 0 when old and daemon plans match", async () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)
    fs.writeFileSync(
      path.join(plansDir, "47", "deadbeef.ndjson"),
      `${JSON.stringify(planLine("a", "source.cell.create", "h1"))}\n`,
    )

    expect(await main([oldDir, plansDir])).toBe(0)
  })

  it("exits 1 when a project has no daemon plan", async () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(plansDir, { recursive: true })

    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)

    expect(await main([oldDir, plansDir])).toBe(1)
  })

  it("exits 1 when hashes differ", async () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)
    fs.writeFileSync(
      path.join(plansDir, "47", "deadbeef.ndjson"),
      `${JSON.stringify(planLine("a", "source.cell.create", "h1-different"))}\n`,
    )

    expect(await main([oldDir, plansDir])).toBe(1)
  })

  it("honours --only to restrict which project ids are compared", async () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    // 47 matches, 48 has no plan at all — but --only 47 should ignore it.
    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)
    fs.writeFileSync(
      path.join(plansDir, "47", "deadbeef.ndjson"),
      `${JSON.stringify(planLine("a", "source.cell.create", "h1"))}\n`,
    )
    fs.writeFileSync(path.join(oldDir, "48.ndjson"), `${JSON.stringify({ id: "z", hash: "hz" })}\n`)

    expect(await main([oldDir, plansDir, "--only", "47"])).toBe(0)
  })

  it("reports the file and line number on a malformed plan line", async () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)
    const planFile = path.join(plansDir, "47", "deadbeef.ndjson")
    fs.writeFileSync(planFile, `${JSON.stringify(planLine("a", "source.cell.create", "h1"))}\nnot json\n`)

    await expect(main([oldDir, plansDir])).rejects.toThrow(`${planFile}:2`)
  })

  it("reports the file and line number on a malformed old-plan line", async () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    const oldFile = path.join(oldDir, "47.ndjson")
    fs.writeFileSync(oldFile, `${JSON.stringify({ id: "a", hash: "h1" })}\nnot json\n`)
    fs.writeFileSync(
      path.join(plansDir, "47", "deadbeef.ndjson"),
      `${JSON.stringify(planLine("a", "source.cell.create", "h1"))}\n`,
    )

    await expect(main([oldDir, plansDir])).rejects.toThrow(`${oldFile}:2`)
  })
})

describe("streaming a large plan", () => {
  const gc = (globalThis as { gc?: () => void }).gc
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-mem-"))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!gc)("compares a ~50k-line plan correctly while staying under 200 MB of heap", async () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    const total = 50_000
    const oldStream = fs.createWriteStream(path.join(oldDir, "47.ndjson"))
    const planStream = fs.createWriteStream(path.join(plansDir, "47", "deadbeef.ndjson"))
    for (let i = 0; i < total; i++) {
      const id = `id-${i}`
      const fileId = `f${i % 100}`
      const hash = i === 0 ? "different" : "h"
      oldStream.write(`${JSON.stringify({ id, hash: "h" })}\n`)
      // A big filler payload on every event mimics the real 512 MB+ plans:
      // the slim ParityLine reader must never retain it.
      const l = planLine(id, "source.cell.create", hash, fileId)
      l.event.payload = { filler: "x".repeat(2000) }
      planStream.write(`${JSON.stringify(l)}\n`)
    }
    await Promise.all([new Promise((r) => oldStream.end(r)), new Promise((r) => planStream.end(r))])

    expect(gc, "run with NODE_OPTIONS=--expose-gc (pnpm test:daemon)").toBeDefined()
    gc!()
    const before = process.memoryUsage().heapUsed
    const code = await main([oldDir, plansDir])
    gc!()
    const after = process.memoryUsage().heapUsed
    console.log(`heap after 50k-line parity: ${(after / 1024 / 1024).toFixed(1)} MB (delta ${((after - before) / 1024 / 1024).toFixed(1)} MB)`)

    expect(code).toBe(1) // the one changed hash makes the run report a diff
    expect(after).toBeLessThan(200 * 1024 * 1024)
  }, 60_000)
})
