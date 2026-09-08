// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { compareProject, main } from "../parity"
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

function line(id: string, kind: string, hash: string, fileId = "f1", cellId?: string): PlanLine {
  return { id, event: ev(id, kind, fileId, cellId), hash }
}

describe("compareProject", () => {
  it("reports all zero for equal sets", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: PlanLine[] = [line("a", "source.cell.create", "h1"), line("b", "source.cell.create", "h2")]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 0, order: 0 })
  })

  it("counts a changed hash", () => {
    const old = new Map([["a", { hash: "h1" }]])
    const plan: PlanLine[] = [line("a", "source.cell.create", "h1-different")]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 1, order: 0 })
  })

  it("counts an extra id present only in the plan", () => {
    const old = new Map([["a", { hash: "h1" }]])
    const plan: PlanLine[] = [line("a", "source.cell.create", "h1"), line("b", "source.cell.create", "h2")]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 1, changed: 0, order: 0 })
  })

  it("counts a missing id present only in old", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: PlanLine[] = [line("a", "source.cell.create", "h1")]
    expect(compareProject(old, plan)).toEqual({ missing: 1, extra: 0, changed: 0, order: 0 })
  })

  it("flags a reconciliation event that lands before its file's last create", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: PlanLine[] = [
      line("a", "source.cell.delete", "h1", "f1", "c1"), // reconciliation before the create — out of order
      line("b", "source.cell.create", "h2", "f1", "c1"),
    ]
    expect(compareProject(old, plan)).toEqual({ missing: 0, extra: 0, changed: 0, order: 1 })
  })

  it("does not flag a reconciliation event that lands after its file's last create", () => {
    const old = new Map([["a", { hash: "h1" }], ["b", { hash: "h2" }]])
    const plan: PlanLine[] = [
      line("a", "source.cell.create", "h1", "f1", "c1"),
      line("b", "source.cell.delete", "h2", "f1", "c1"),
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

  it("exits 0 when old and daemon plans match", () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)
    fs.writeFileSync(
      path.join(plansDir, "47", "deadbeef.ndjson"),
      `${JSON.stringify(line("a", "source.cell.create", "h1"))}\n`,
    )

    expect(main([oldDir, plansDir])).toBe(0)
  })

  it("exits 1 when a project has no daemon plan", () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(plansDir, { recursive: true })

    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)

    expect(main([oldDir, plansDir])).toBe(1)
  })

  it("exits 1 when hashes differ", () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)
    fs.writeFileSync(
      path.join(plansDir, "47", "deadbeef.ndjson"),
      `${JSON.stringify(line("a", "source.cell.create", "h1-different"))}\n`,
    )

    expect(main([oldDir, plansDir])).toBe(1)
  })

  it("honours --only to restrict which project ids are compared", () => {
    const oldDir = path.join(dir, "old")
    const plansDir = path.join(dir, "plans")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(path.join(plansDir, "47"), { recursive: true })

    // 47 matches, 48 has no plan at all — but --only 47 should ignore it.
    fs.writeFileSync(path.join(oldDir, "47.ndjson"), `${JSON.stringify({ id: "a", hash: "h1" })}\n`)
    fs.writeFileSync(
      path.join(plansDir, "47", "deadbeef.ndjson"),
      `${JSON.stringify(line("a", "source.cell.create", "h1"))}\n`,
    )
    fs.writeFileSync(path.join(oldDir, "48.ndjson"), `${JSON.stringify({ id: "z", hash: "hz" })}\n`)

    expect(main([oldDir, plansDir, "--only", "47"])).toBe(0)
  })
})
