/**
 * Smart Extensions apiRev 5 — what dev's built-in editor gained after the
 * rev-4 parity claim, carried into the extension editor:
 *
 * - AQU-757 integrity explanations on the gutter number and ribbon (and the
 *   "Not yet validated" low-confidence hint);
 * - Align styles for IDML multi-run cells (ai.alignStyles);
 * - the AI-draft provenance wash (#946: validated vs guessed words);
 * - the built-in's read-only / archived-lane banner (AQU-1463);
 * - focus locks on the active lane only (AQU-1808);
 * - per-connection presence after the roster collapsed to one row per user
 *   (AQU-1791).
 *
 * Host derivations are the built-in's own functions; the SDK renders are
 * checked through the shipped runtime in the fake frame.
 */

import { describe, it, expect, vi } from "vitest"
import { DEFAULT_EDITOR_MANIFEST, DEFAULT_EDITOR_SOURCE } from "../../../../shared/tools/first-party/default-editor"
import { TOOL_SCOPES } from "../../../../shared/tools/manifest"
import type { ToolCellView, ToolHostData } from "../host-handlers"
import { createBridgeHost } from "../host-bridge"
import { createToolHandlers } from "../host-handlers"
import { HOST_SHORTCUTS } from "../host-keys"
import { defaultSmokeFixtures } from "../smoke"
import { buildToolSrcdoc } from "../srcdoc"
import { createFakeFramePair } from "./fake-frame"
import { healthSpansForCell, issueRuleName, lockHoldersOnLane, ribbonNeedsAttention } from "../editor-parity-rev5"
import { extensionEditorReadOnlyBanner } from "../editor-write-caps"
import { createProjectPresenceStore } from "@/lib/sync/presence-store"
import { ROLE } from "@/lib/sync/role-policy"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { HealthRibbonPoint } from "@/lib/health/health-ribbon"
import type { TFunction } from "@/lib/i18n/I18nProvider"

const t = ((key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key)) as unknown as TFunction

describe("apiRev 5 host derivations (the built-in's own rules)", () => {
  it("locks only rows leased on the active lane (AQU-1808)", () => {
    const holders = new Map([["c1", "ana"], ["c2@lane:fr", "bob"], ["c3@lane:es", "cy"]])
    expect([...lockHoldersOnLane(holders, "")]).toEqual([["c1", "ana"]])
    expect([...lockHoldersOnLane(holders, "fr")]).toEqual([["c2", "bob"]])
    // A named lane never falls back to the default lane's bare key.
    expect(lockHoldersOnLane(holders, "fr").has("c1")).toBe(false)
    expect([...lockHoldersOnLane(holders, "es", ["c1", "c3"])]).toEqual([["c3", "cy"]])
    expect(lockHoldersOnLane(null, "").size).toBe(0)
  })

  it("flags low confidence exactly as EditorTable's cellNeedsAttention does (AQU-757)", () => {
    const point = (stage: HealthRibbonPoint["stage"], smoothedScore?: number) => ({ stage, smoothedScore }) as HealthRibbonPoint
    expect(ribbonNeedsAttention(point("automatic", 20), true, 0.5)).toBe(true)
    expect(ribbonNeedsAttention(point("automatic", 90), true, 0.5)).toBe(false)
    expect(ribbonNeedsAttention(point("automatic", 20), false, 0.5)).toBe(false)
    expect(ribbonNeedsAttention(point("validated", 20), true, 0.5)).toBe(false)
    expect(ribbonNeedsAttention(point("automatic"), true, 0.5)).toBe(false)
  })

  it("builds the provenance wash only for AI drafts with the setting on, from the live draft when given (#946)", () => {
    const cell = {
      translated: "Jesús nació en Belén",
      aiDrafted: true,
      aiDraft: { exampleTexts: [{ cellId: "e1", source: "Jesus was born", target: "Jesús nació allí" }] },
    }
    expect(healthSpansForCell({ enabled: false, cell, t })).toBeNull()
    expect(healthSpansForCell({ enabled: true, cell: { ...cell, aiDrafted: false }, t })).toBeNull()
    const spans = healthSpansForCell({ enabled: true, cell, t })!
    expect(spans[0]).toMatchObject({ start: 0, end: "Jesús nació".length, kind: "supported" })
    expect(spans[0].title).toContain("editor.health.citedExample")
    expect(spans.some((s) => s.kind === "guessed")).toBe(true)
    const live = healthSpansForCell({ enabled: true, cell, text: "Otro texto", t })!
    expect(live.every((s) => s.kind === "guessed")).toBe(true)
  })

  it("names the check the way the built-in's hover does", () => {
    expect(issueRuleName(undefined, "r9", t)).toBe("r9")
    expect(issueRuleName({ id: "r1", name: "Key terms" } as never, "r1", t)).toBe("Key terms")
  })
})

describe("apiRev 5 read-only banner (the built-in's wording)", () => {
  const project = (level: number | null, extra: Partial<ProjectRecord> = {}) =>
    ({ id: "p", name: "P", syncRole: level === null ? undefined : { level }, ...extra }) as unknown as ProjectRecord
  it("an archived lane outranks the role and says what is still possible (AQU-1463)", () => {
    const b = extensionEditorReadOnlyBanner({ project: project(ROLE.MAINTAINER), archivedLaneLabel: "Swahili", username: "ana", t })
    expect(b).toEqual({ readOnlyLabel: "Swahili is archived — read-only. You can still read, search, export and comment.", readOnlyKind: "lane-archived" })
  })
  it("viewers and commenters get the role banner; contributors none", () => {
    expect(extensionEditorReadOnlyBanner({ project: project(ROLE.VIEWER), archivedLaneLabel: null, username: "ana", t }))
      .toEqual({ readOnlyLabel: "Viewing as viewer — read only", readOnlyKind: "role" })
    expect(extensionEditorReadOnlyBanner({ project: project(ROLE.COMMENTER), archivedLaneLabel: null, username: "ana", t }).readOnlyLabel)
      .toBe("Viewing as commenter — you can comment")
    expect(extensionEditorReadOnlyBanner({ project: project(ROLE.CONTRIBUTOR), archivedLaneLabel: null, username: "ana", t }))
      .toEqual({ readOnlyLabel: null, readOnlyKind: null })
  })
})

describe("apiRev 5 presence (AQU-1791)", () => {
  it("keeps one row per connection for cell presence while the roster collapses a user", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceFrame([
      { userId: "bob", connId: "b1", currentFileId: "f", focusedCell: "c1", ts: 1 },
      { userId: "bob", connId: "b2", currentFileId: "f", viewingCell: "c4", ts: 2 },
    ])
    expect(store.getPeers()).toHaveLength(1)
    const rows = store.getConnectionPeers()
    expect(rows.map((p) => p.focusedCell ?? p.viewingCell).sort()).toEqual(["c1", "c4"])
    // Stable identity until the roster changes (useSyncExternalStore-safe).
    expect(store.getConnectionPeers()).toBe(rows)
  })
})

// ── The SDK editor, through the shipped runtime ────────────────────────────

function mount(data: ToolHostData) {
  const pair = createFakeFramePair()
  const host = createBridgeHost({ getFrameWindow: () => pair.frame as unknown as Window, handlers: createToolHandlers(data), authorize: async () => {} })
  const stop = host.listen(pair.host as unknown as Window)
  pair.run(buildToolSrcdoc(DEFAULT_EDITOR_SOURCE, {
    tool: { id: "fp", name: "Aquilla Editor", version: 1 },
    project: { id: "p", name: "P" },
    user: { username: "alice", roleLevel: 400 },
    mount: "editor",
    file: { fileId: "f1", name: "MAT" },
    theme: {},
    hostShortcuts: HOST_SHORTCUTS,
  }, { sdk: DEFAULT_EDITOR_MANIFEST.sdk }))
  const q = (sel: string) => pair.doc.querySelector(sel) as HTMLElement | null
  const row = (cellId: string) => q(`.cell[data-cell-id="${cellId}"]`)
  return { pair, stop, q, row }
}

const EXTRA: Record<string, Partial<ToolCellView>> = {
  c1: {
    healthSpans: [{ start: 0, end: 5, kind: "supported", title: "Libro → Libro" }, { start: 6, end: 8, kind: "guessed" }],
    ribbon: { stage: "automatic", background: "none", score: 20, label: "Automatic health 20%", needsAttention: true },
  },
  c4: { canAlignStyles: true },
}

function withRev5(over: Partial<ToolHostData> = {}): ToolHostData {
  const base = defaultSmokeFixtures({ ...DEFAULT_EDITOR_MANIFEST, scopes: [...TOOL_SCOPES] })[1].data
  const add = (cells: ToolCellView[]) => cells.map((c) => ({ ...c, ...(EXTRA[c.cellId] ?? {}) }))
  return {
    ...base,
    pageCells: async (...args) => {
      const page = await base.pageCells(...args)
      return { ...page, cells: add(page.cells) }
    },
    getCells: async (...args) => add(await base.getCells(...args)),
    ...over,
  }
}

describe("apiRev 5 in the extension editor (SDK)", () => {
  it("explains the tint: each check and why it fired, else Not yet validated (AQU-757)", async () => {
    const { row, stop } = mount(withRev5())
    await vi.waitFor(() => expect(row("c2")?.querySelector("[data-testid=cell-issue-flag]")).toBeTruthy())
    const flag = row("c2")!.querySelector("[data-testid=cell-issue-flag]")!
    expect(flag.getAttribute("role")).toBe("img")
    expect(flag.getAttribute("aria-label")).toContain("Key terms — Use the approved rendering")
    const lowConfidence = row("c1")!.querySelector(".num")!
    expect(lowConfidence.className).toContain("issue")
    expect(lowConfidence.getAttribute("aria-label")).toContain("Not yet validated — confidence on this line is still low")
    // A clean line stays a plain number.
    expect(row("c4")!.querySelector(".num")!.getAttribute("data-testid")).toBeNull()
    stop()
  })

  it("offers Align styles as the last cell-menu action on IDML multi-run cells, through the host pipeline", async () => {
    const alignStyles = vi.fn(async () => true)
    const { row, q, stop } = mount(withRev5({ alignStyles }))
    await vi.waitFor(() => expect(row("c4")).toBeTruthy())
    ;(row("c4")!.querySelector("[data-slot=cell-action-rail-overflow]") as HTMLElement).click()
    const items = [...(q(".overflow")?.querySelectorAll("button") ?? [])]
    const align = items[items.length - 1]
    expect(align.getAttribute("aria-label")).toBe("Align styles")
    align.click()
    await vi.waitFor(() => expect(alignStyles).toHaveBeenCalledWith("f1", "c4"))
    // A cell with one run never offers it.
    ;(row("c1")!.querySelector("[data-slot=cell-action-rail-overflow]") as HTMLElement).click()
    expect([...(q(".overflow")?.querySelectorAll("button") ?? [])].some((b) => b.getAttribute("aria-label") === "Align styles")).toBe(false)
    stop()
  })

  it("paints the provenance wash over an AI draft (#946)", async () => {
    const { row, stop } = mount(withRev5())
    await vi.waitFor(() => expect(row("c1")?.querySelector("[data-target-read-view]")?.getAttribute("data-health-spans")).toBe("1/1"))
    expect(row("c2")?.querySelector("[data-target-read-view]")?.hasAttribute("data-health-spans")).toBe(false)
    stop()
  })

  it("shows the built-in's banner wording and testid for an archived lane (AQU-1463)", async () => {
    const base = withRev5()
    const { q, stop } = mount({
      ...base,
      editorConfig: async (fileId) => ({ ...(await base.editorConfig(fileId)), canEdit: false, canValidate: false,
        readOnlyLabel: "Swahili is archived — read-only. You can still read, search, export and comment.", readOnlyKind: "lane-archived" }),
    })
    await vi.waitFor(() => expect(q("[data-testid=lane-archived-banner]")?.textContent).toContain("Swahili is archived — read-only"))
    stop()
  })
})
