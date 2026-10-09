/**
 * apiRev 3 (editor parity): param validation of the new bridge calls, the
 * store-backed reads an editor mount gets (one read of the file shared with
 * the workspace), the host pipeline delegation with tool provenance, bound-
 * file refusal, ui.strings, the suggestion registry, and round trips through
 * the shipped runtime.
 */

import { describe, it, expect, vi } from "vitest"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { createBridgeHost } from "../host-bridge"
import { createToolHandlers, type ToolHostData } from "../host-handlers"
import { LiveEditorData } from "../live-data-editor"
import { cellToToolView, pageFromStore, termMatchesFor, type ToolEditorServices } from "../editor-services"
import { smokeEditorConfig } from "../smoke-editor"
import { defaultSmokeFixtures } from "../smoke"
import { uiStrings } from "../ui-strings"
import { memorySuggestions, registerSuggestionProvider, suggestFor } from "../suggestions"
import { METHOD_SCOPES } from "../permissions"
import { buildToolSrcdoc } from "../srcdoc"
import { createFakeFramePair } from "./fake-frame"
import { TOOLS_API_REV, TOOL_SCOPES } from "../../../../shared/tools/manifest"
import type { ToolOrigin } from "../../../../shared/tools/manifest"
import type { Concept } from "@/lib/terminology/types"

const ORIGIN: ToolOrigin = { origin: "tool", toolId: "t1", version: 1, codeHash: "a".repeat(64) }

function row(cellId: string, side: "source" | "target", value: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId, side, value, valueHtml: null, type: null, canonicalRef: side === "source" ? `MRK 1:${cellId.slice(1)}` : null, anchorCellId: null,
    eventId: `${side}-${cellId}`, sourceEventId: null, lastEditor: "alice", lastEditAt: 1, validated: false, wordCount: 1, endorsementCount: 0, ...over,
  }
}

function makeStore(n = 5): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: "p1", fileId: "f1", username: "alice", requiredValidations: 1, auditStats: new Map() })
  const rows: CellRow[] = []
  for (let i = 1; i <= n; i++) {
    rows.push(row(`c${i}`, "source", i === 2 ? "Jesus went up \\f + \\ft A note\\f*" : `Source ${i} Jesus`))
    if (i <= 2) rows.push(row(`c${i}`, "target", `Lengo ${i}`))
  }
  store.replaceRows(rows)
  return store
}

function services(store: CellStore, over: Partial<ToolEditorServices> = {}): ToolEditorServices {
  const noop = () => {}
  return {
    store, storeLoading: false, config: smokeEditorConfig(true), signals: { stale: [], upstreamStale: [], assignments: {}, repetition: {}, issues: {}, health: {}, ai: {}, backtranslating: [], remoteChanged: [] },
    peers: [], backtranslations: new Map(), selection: [], pericopes: [], concepts: [],
    commitTarget: vi.fn(async () => ({ autoValidated: false })), setValidation: vi.fn(async () => true), settle: vi.fn(),
    draft: vi.fn(async () => true), openAiSetup: vi.fn(), draftParagraph: vi.fn(async () => true), backtranslate: vi.fn(async () => true), saveBacktranslation: vi.fn(() => true),
    openHistory: vi.fn(), openAttachments: vi.fn(), openRule: vi.fn(), openTerm: vi.fn(), openRecorder: vi.fn(), generateAudio: vi.fn(async () => true),
    typing: vi.fn(), viewing: vi.fn(), visible: vi.fn(), setSelection: vi.fn(), setLane: vi.fn(), setLens: vi.fn(), openSettings: vi.fn(),
    suggest: vi.fn(async () => []), suggestionFeedback: noop, ribbonFor: () => null,
    structureFor: () => ({ rowIndex: 0, contentNumber: 1, scriptureNumbering: true, paragraph: null }),
    ...over,
  }
}

describe("apiRev 3 — store-backed editor data", () => {
  it("pages the workspace's own store (no second fetch), with apiRev 3 fields", () => {
    const store = makeStore()
    const page = pageFromStore(store, null, 3, false)
    expect(page.cells.map((c) => c.cellId)).toEqual(["c1", "c2", "c3"])
    expect(page.nextCursor).toBe("3")
    const last = pageFromStore(store, "3", 3, false)
    expect(last.cells.map((c) => c.cellId)).toEqual(["c4", "c5"])
    expect(last.nextCursor).toBeNull()
    // Still loading: a cursor even at the end, so the extension keeps asking.
    expect(pageFromStore(store, "3", 3, true).nextCursor).toBe("5")
    const c2 = cellToToolView(store, store.getCellView("c2")!)
    expect(c2).toMatchObject({ ref: "MRK 1:2", target: "Lengo 2", validators: [], paragraphStart: false })
    expect(c2.footnotes?.source).toEqual([{ caller: "+", text: "A note" }])
  })

  it("delegates writes to the host pipeline with tool provenance, and refuses another file", async () => {
    const store = makeStore()
    const svc = services(store)
    const data = new LiveEditorData({ services: () => svc, boundFile: () => "f1", origin: ORIGIN })
    const res = await data.commit([{ fileId: "f1", cellId: "c1", value: "Mpya", html: "<p>Mpya</p>" }], (h) => h)
    expect(res).toEqual({ committed: ["c1"], failed: [] })
    expect(svc.commitTarget).toHaveBeenCalledWith("c1", { value: "Mpya", valueHtml: "<p>Mpya</p>" }, ORIGIN)
    // Unchanged text is a no-op success (no event).
    await data.commit([{ fileId: "f1", cellId: "c2", value: "Lengo 2" }], (h) => h)
    expect(svc.commitTarget).toHaveBeenCalledTimes(1)
    const v = await data.setValidation([{ fileId: "f1", cellId: "c1" }, { fileId: "f1", cellId: "c4" }], true)
    expect(v).toEqual({ validated: ["c1"], failed: [{ cellId: "c4", reason: "no_translation" }] })
    expect(svc.setValidation).toHaveBeenCalledWith("c1", true, ORIGIN)
    await expect(data.draft("other-file", ["c1"], { regenerate: false })).rejects.toMatchObject({ code: "not_available" })
    expect(data.for("other-file")).toBeNull()
  })

  it("reports exactly the cells whose store version moved since the extension read them", async () => {
    const store = makeStore()
    const svc = services(store)
    const data = new LiveEditorData({ services: () => svc, boundFile: () => "f1", origin: ORIGIN })
    await data.page("f1", null, 10)
    expect(data.changedSinceSeen(svc)).toEqual([])
    store.applyOptimisticTargetEdit("c3", { value: "Tatu" })
    expect(data.changedSinceSeen(svc)).toEqual(["c3"])
    expect(data.changedSinceSeen(svc)).toEqual([])
  })

  it("gates AI drafting on configuration and passes cells through to the host", async () => {
    const store = makeStore()
    const svc = services(store)
    const data = new LiveEditorData({ services: () => svc, boundFile: () => "f1", origin: ORIGIN })
    await data.draft("f1", ["c3", "missing"], { regenerate: true })
    expect(svc.draft).toHaveBeenCalledWith(["c3"], { regenerate: true })
    svc.config = { ...svc.config, ai: { configured: false, available: true } }
    await expect(data.draft("f1", ["c3"], { regenerate: false })).rejects.toMatchObject({ code: "ai_not_configured" })
    expect(await data.setLens("agent")).toBe(true)
    expect(svc.setLens).toHaveBeenCalledWith("agent")
    await expect(data.setLane("f1", "nope")).rejects.toMatchObject({ code: "invalid_params" })
  })

  it("finds key terms in source and renderings (forbidden flagged) in target", () => {
    const store = makeStore()
    const concepts: Concept[] = [{ id: "k1", sourceTerm: "Jesus", status: "active", createdAt: "", renderings: [{ rendering: "Lengo", status: "forbidden" }] }]
    const m = termMatchesFor(store, ["c1", "c3"], concepts)
    expect(m.c1).toEqual([
      expect.objectContaining({ side: "source", term: "Jesus", conceptId: "k1" }),
      expect.objectContaining({ side: "target", start: 0, end: 5, forbidden: true }),
    ])
    expect(m.c3?.map((x) => x.side)).toEqual(["source"])
  })
})

describe("apiRev 3 — handlers, scopes and the shipped runtime", () => {
  function stub(): ToolHostData {
    return defaultSmokeFixtures({ name: "x", description: "", scopes: [...TOOL_SCOPES], mounts: ["page", "editor"], apiRev: 3 })[1].data
  }

  it("validates params", async () => {
    const h = createToolHandlers(stub())
    await expect(h["ai.draft"]({ fileId: "f1", cellIds: [] })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["ai.draft"]({ fileId: "f1", cellIds: Array.from({ length: 201 }, (_, i) => `c${i}`) })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["editor.setLens"]({ lens: "video" })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["editor.openSettings"]({ section: "billing" })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["presence.typing"]({ fileId: "f1", cellId: "c1", selection: { anchor: -1, head: 0 } })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["backtranslation.save"]({ fileId: "f1", cellId: "c1", text: "x".repeat(20_001) })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["ui.strings"]({ keys: "editor.x" })).rejects.toMatchObject({ code: "invalid_params" })
  })

  it("maps every new write to a scope (AI → ai:draft, audio → write:audio)", () => {
    expect(METHOD_SCOPES["ai.draft"]).toBe("ai:draft")
    expect(METHOD_SCOPES["backtranslation.run"]).toBe("ai:draft")
    expect(METHOD_SCOPES["audio.generate"]).toBe("write:audio")
    expect(METHOD_SCOPES["audio.record"]).toBe("write:audio")
    expect(METHOD_SCOPES["presence.typing"]).toBe("write:target")
    expect(METHOD_SCOPES["cells.settle"]).toBe("write:target")
    expect(METHOD_SCOPES["terms.matches"]).toBe("read:terms")
  })

  it("round-trips through the runtime", async () => {
    const pair = createFakeFramePair()
    const host = createBridgeHost({ getFrameWindow: () => pair.frame as unknown as Window, handlers: createToolHandlers(stub()), authorize: async () => {} })
    const stop = host.listen(pair.host as unknown as Window)
    pair.run(buildToolSrcdoc("<script></script>", { tool: { id: "t", name: "T", version: 1 }, project: { id: "p", name: "P" }, user: { username: "u", roleLevel: 400 }, mount: "editor", file: { fileId: "f1", name: "MAT" }, theme: {} }))
    type Aq = Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> & { apiRev: number }
    const aq = pair.frame.aquilla as Aq
    expect(aq.apiRev).toBe(TOOLS_API_REV)
    expect(await aq.editor.config("f1")).toMatchObject({ fileId: "f1", ai: { configured: true } })
    expect(await aq.cells.sections("f1")).toHaveLength(2)
    expect(await aq.cells.signals("f1")).toMatchObject({ stale: ["c2"] })
    expect(await aq.cells.pericopes("f1")).toEqual([expect.objectContaining({ cellId: "c3" })])
    expect(await aq.ai.draft("f1", ["c3"])).toBe(true)
    expect(await aq.suggestions.get("f1", "c1", "Lib")).toEqual([expect.objectContaining({ text: " de David" })])
    expect(await aq.ui.strings(["editor.column.source", "billing.secret", "editor.comments.open"])).toMatchObject({
      locale: "en", strings: { "editor.column.source": "Source", "editor.comments.open": { forms: { one: "{count} open comment" } } },
    })
    stop()
  })
})

describe("apiRev 3 — ui.strings and suggestions", () => {
  it("serves only public UI namespaces, falling back to English", () => {
    const res = uiStrings("fr", ["editor.column.source", "auth.password", "agentWorkspace.editHistory"])
    expect(Object.keys(res.strings).sort()).toEqual(["agentWorkspace.editHistory", "editor.column.source"])
    expect(uiStrings("ar", ["editor.column.source"]).dir).toBe("rtl")
  })

  it("asks every provider, prefixes ids, drops slow or failing ones, and offers translation memory", async () => {
    expect(memorySuggestions([{ cellId: "a", source: "In the beginning", target: "Hapo mwanzo Mungu" }], { cellId: "b", fileId: "f", source: "in the  beginning", prefix: "Hapo " }))
      .toEqual([{ id: "a", text: "mwanzo Mungu" }])
    const off1 = registerSuggestionProvider({ id: "forecast", suggest: () => [{ id: "x", text: " ghost" }] })
    const off2 = registerSuggestionProvider({ id: "broken", suggest: () => { throw new Error("no") } })
    const got = await suggestFor({ cellId: "b", fileId: "f", source: "s", prefix: "p" })
    expect(got).toEqual([{ id: "forecast:x", text: " ghost", source: "forecast" }])
    off1(); off2()
  })
})
