/**
 * LiveToolData apiRev 2: rich text is sanitized in BOTH directions, writes stay
 * ordinary events with tool provenance (commit html, unvalidate), a remote edit
 * invalidates only its cells, and workspace services are bound to the mounted
 * file.
 */

import { beforeEach, describe, it, expect, vi } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"

const rows: CellRow[] = []
const byIds = vi.fn<(...a: unknown[]) => Promise<CellRow[]>>()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: vi.fn(async () => rows),
  fetchProjectFiles: vi.fn(async () => []),
  fetchFileCells: vi.fn(async () => ({ cells: rows, nextCursor: null, total: rows.length, completeRows: true })),
  fetchCellsByIds: (...a: unknown[]) => byIds(...a),
}))
vi.mock("@/lib/sync/project-settings", () => ({ fetchProjectSettings: vi.fn(async () => ({ lanes: [] })) }))
const commits = vi.fn<(inputs: unknown[]) => Promise<string[]>>(async (inputs) => inputs.map((_, i) => `ev-new-${i}`))
const unvalidates = vi.fn<(input: unknown) => Promise<string>>(async () => "ev-unval")
vi.mock("@/lib/sync/events-emit", () => ({
  emitTargetCellCommits: (inputs: unknown[]) => commits(inputs),
  emitCellValidate: vi.fn(async () => "ev-val"),
  emitCellUnvalidate: (input: unknown) => unvalidates(input),
}))

// happy-dom's DOM walk does not reproduce DOMPurify's browser behaviour (see
// src/lib/richtext/source-display-sanitizer.test.ts), so these tests pin that
// every HTML crossing goes THROUGH the editor's allowlist sanitizer; its output
// is covered there and in the browser e2e.
vi.mock("@/lib/richtext/editor-content", () => ({ sanitizeSourceDisplayHtml: (h: string) => `SANITIZED[${h}]` }))

import { LiveToolData, pairRows, type ToolHostServices } from "../live-data"

const ORIGIN = { origin: "tool" as const, toolId: "t1", version: 1, codeHash: "a".repeat(64) }

function row(cellId: string, side: "source" | "target", value: string, extra: Partial<CellRow> = {}): CellRow {
  return {
    cellId, side, value, valueHtml: null, type: null, canonicalRef: `MAT 1:${cellId.slice(1)}`, anchorCellId: null,
    eventId: `${side}-${cellId}`, sourceEventId: side === "target" ? `source-${cellId}` : null, lastEditor: "bob",
    lastEditAt: 1, validated: false, wordCount: 1, targetLang: "", ...extra,
  }
}

function make(services: ToolHostServices = {}) {
  return new LiveToolData({
    projectId: "p1",
    sessionJwt: "jwt",
    author: "alice",
    toolOrigin: ORIGIN,
    tokenFor: async () => "tok",
    flush: vi.fn(),
    notify: vi.fn(),
    tell: vi.fn(),
    grantedScopes: () => [],
    requestScope: async () => true,
    storageKey: "k",
    services: () => services,
  })
}

beforeEach(() => {
  rows.length = 0
  rows.push(
    row("c1", "source", "In the beginning", { valueHtml: `<p>In the <b>beginning</b><img src=x onerror="alert(1)"><script>bad()</script></p>` }),
    row("c1", "target", "Al principio", { valueHtml: `<p><a href="https://evil.example">Al</a> principio</p>` }),
    row("c2", "source", "was the Word"),
  )
  byIds.mockReset()
  commits.mockClear()
  unvalidates.mockClear()
})

describe("LiveToolData apiRev 2", () => {
  it("hands the frame sanitized rich text only", () => {
    const c1 = pairRows(rows, "").get("c1")!.view
    expect(c1.sourceHtml).toBe(`SANITIZED[${rows[0].valueHtml}]`)
    expect(c1.targetHtml).toBe(`SANITIZED[${rows[1].valueHtml}]`)
    expect(c1.lastEditor).toBe("bob")
    expect(pairRows(rows, "").get("c2")!.view.targetHtml).toBeNull()
  })

  it("sanitizes commit html and writes an ordinary commit with tool provenance", async () => {
    const data = make()
    await data.listCells("f1", "")
    const res = await data.commit([{ fileId: "f1", cellId: "c2", value: "era el Verbo", html: `<p>era el <i>Verbo</i><img src=x onerror="steal()"></p>` }])
    expect(res).toEqual({ committed: ["c2"], failed: [] })
    expect(commits).toHaveBeenCalledTimes(1)
    const input = commits.mock.calls[0][0][0] as Record<string, unknown>
    expect(input).toMatchObject({ value: "era el Verbo", valueHtml: `SANITIZED[<p>era el <i>Verbo</i><img src=x onerror="steal()"></p>]`, toolOrigin: ORIGIN, author: "alice" })
    // Chained on the source head (no prior target row).
    expect(input.parentId).toBe("source-c2")
  })

  it("unvalidates against the live head with provenance", async () => {
    const data = make()
    await data.listCells("f1", "")
    const res = await data.unvalidate([{ fileId: "f1", cellId: "c1" }, { fileId: "f1", cellId: "c2" }])
    expect(res.validated).toEqual(["c1"])
    expect(res.failed).toEqual([{ cellId: "c2", reason: "no_translation" }])
    expect(unvalidates).toHaveBeenCalledWith(expect.objectContaining({ editEventId: "target-c1", toolOrigin: ORIGIN }))
  })

  it("a remote edit re-reads only the changed cell before the next write chains on it", async () => {
    const data = make()
    await data.listCells("f1", "")
    byIds.mockResolvedValueOnce([row("c1", "source", "In the beginning"), row("c1", "target", "Al comienzo", { eventId: "target-c1-v2" })])
    data.invalidateCells("f1", ["c1"])
    await data.commit([{ fileId: "f1", cellId: "c1", value: "En el principio" }])
    expect(byIds).toHaveBeenCalledWith("p1", "f1", ["c1"], "tok", undefined)
    expect((commits.mock.calls[0][0][0] as Record<string, unknown>).parentId).toBe("target-c1-v2")
  })

  it("binds presence and comments to the mounted file and strips lane-qualified lock keys", async () => {
    const claim = vi.fn()
    const data = make({
      fileId: "f1",
      lockHolders: new Map([["c1@lane:es", "bob"], ["c2", "carol"]]),
      claimCell: claim,
      commentCounts: new Map([["c1", 2], ["other-file-cell", 1]]),
    })
    await data.listCells("f1", "")
    await expect(data.listPresence("f1")).resolves.toEqual({ c1: { username: "bob" }, c2: { username: "carol" } })
    await expect(data.listPresence("f2")).resolves.toEqual({})
    await expect(data.claimCell("f2", "c1")).resolves.toBe(false)
    await expect(data.claimCell("f1", "c1")).resolves.toBe(true)
    expect(claim).toHaveBeenCalledWith("c1")
    await expect(data.commentCounts("f1")).resolves.toEqual({ c1: 2 })
  })

  it("without workspace services (page/panel mounts) the calls answer empty", async () => {
    const data = make()
    await expect(data.listPresence("f1")).resolves.toEqual({})
    await expect(data.claimCell("f1", "c1")).resolves.toBe(false)
    await expect(data.openComments("f1", "c1")).resolves.toBe(false)
  })
})
