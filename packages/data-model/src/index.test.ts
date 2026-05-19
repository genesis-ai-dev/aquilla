import { describe, expect, it } from "vitest"
import {
  CHAIN_MUTATING_KINDS,
  type CellRow,
  type RawEvent,
  type Project,
  type ProjectSettings,
} from "./index"

describe("@aquilla/data-model", () => {
  it("CHAIN_MUTATING_KINDS includes every source.* and target.* cell event", () => {
    // AD-2: these kinds advance cells.event_id on success.
    expect(CHAIN_MUTATING_KINDS.has("source.cell.create")).toBe(true)
    expect(CHAIN_MUTATING_KINDS.has("source.cell.commit")).toBe(true)
    expect(CHAIN_MUTATING_KINDS.has("source.cell.delete")).toBe(true)
    expect(CHAIN_MUTATING_KINDS.has("source.cell.reorder")).toBe(true)
    expect(CHAIN_MUTATING_KINDS.has("target.cell.create")).toBe(true)
    expect(CHAIN_MUTATING_KINDS.has("target.cell.commit")).toBe(true)
    expect(CHAIN_MUTATING_KINDS.has("target.cell.delete")).toBe(true)
    expect(CHAIN_MUTATING_KINDS.has("target.cell.reorder")).toBe(true)
  })

  it("CHAIN_MUTATING_KINDS excludes validation + file events", () => {
    // These update other tables but don't advance cells.event_id.
    expect(CHAIN_MUTATING_KINDS.has("cell.validate" as never)).toBe(false)
    expect(CHAIN_MUTATING_KINDS.has("cell.unvalidate" as never)).toBe(false)
    expect(CHAIN_MUTATING_KINDS.has("file.create" as never)).toBe(false)
  })

  it("type smoke: RawEvent envelope is constructible", () => {
    // Compile-time: this would not type-check if the shape regressed.
    const ev: RawEvent<"target.cell.commit"> = {
      id: "01HK0000000000000000000000",
      schemaVersion: 1,
      kind: "target.cell.commit",
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      parentId: "01HJ0000000000000000000000",
      author: "alice",
      payload: { value: "hola", sourceEventId: null },
      clientTs: 1_700_000_000_000,
    }
    expect(ev.kind).toBe("target.cell.commit")
  })

  it("type smoke: CellRow target row carries sourceEventId; source row doesn't", () => {
    const target: CellRow = {
      cellId: "c1",
      side: "target",
      value: "hola",
      valueHtml: null,
      type: "verse",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: "01HK0000000000000000000001",
      sourceEventId: "01HK0000000000000000000002",
      lastEditor: "alice",
      lastEditAt: 1_700_000_000_000,
      validated: false,
      endorsementCount: 0,
      wordCount: 1,
    }
    expect(target.sourceEventId).not.toBeNull()
    expect(target.side).toBe("target")
  })

  it("type smoke: Project supports AD-9 sourceProjectId", () => {
    const linked: Project = {
      id: "p2",
      name: "Spanish NT",
      orgId: null,
      createdBy: 1,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      sourceProjectId: "p1", // linked-target shape
      archivedAt: null,
      archivedBy: null,
    }
    expect(linked.sourceProjectId).toBe("p1")
  })

  it("type smoke: ProjectSettings carries version for optimistic concurrency", () => {
    const settings: ProjectSettings = {
      projectId: "p1",
      settings: { sourceLanguage: "eng" }, // source-only: targetLanguage omitted
      version: 5,
      updatedAt: "2026-01-01",
      updatedBy: 1,
    }
    expect(settings.version).toBe(5)
    expect(settings.settings.targetLanguage).toBeUndefined()
  })
})
