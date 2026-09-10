// AQU-1154: the focus lock is ADVISORY on the write path.
//
// This file used to pin the opposite (RACE-5): `handleEditorCommit` consulted
// the presence-derived lock map (`checkLockHolder(cell.id) ?? lockHolderLabel`)
// and silently returned when it named someone else. Under a flaky link that
// threw the user's text away: a socket flap made the DO release their lease,
// the reconnect did not re-claim, a peer claimed the cell, and the next
// idle/blur commit was dropped with only a console.warn — while their editor
// still showed the text. The server is the arbiter (POST /events never
// consulted leases; the head-check does the real conflict detection), so the
// client must always hand the commit to the outbox and let stale handling
// surface any loss.
//
// The contract now:
//   • presence/lock frames drive ONLY the read-only affordance + the
//     "X is editing" label (`cellLockHolders`, see cell-lock-state.ts);
//   • a commit from an editor that is already open proceeds even when the
//     lock map names another holder.
//
// Part 1 renders the real EditorTable → TranslatedEditor commit path with a
// mocked `emitTargetCellCommit`; part 2 keeps the B4 object-identity
// invariants for the label-driving helpers.

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, Fragment, forwardRef, useImperativeHandle, type ReactNode } from "react"
import type { Editor } from "@tiptap/core"
import { EditorTable } from "@/components/EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { emitTargetCellCommit } from "./events-emit"
import {
  applyPresenceFrame,
  applyLockClaimed,
  applyLockReleased,
} from "./cell-lock-state"

vi.mock("./events-emit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./events-emit")>()
  return { ...actual, emitTargetCellCommit: vi.fn(async () => "evt-commit-1") }
})

// happy-dom has no layout engine, so LegendList may render no rows. Replace it
// with a trivial "render every row" stand-in (same stand-in as the other
// EditorTable RTL suites).
vi.mock("@legendapp/list/react", () => ({
  LegendList: forwardRef(function MockLegendList({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: string[]
    renderItem: (props: { item: string; index: number }) => ReactNode
    keyExtractor?: (item: string, index: number) => string
  }, ref) {
    useImperativeHandle(ref, () => ({
      getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
      scrollToIndex: async () => undefined,
      scrollToOffset: async () => undefined,
    }))
    return createElement(
      "div",
      null,
      data.map((item, index) =>
        createElement(Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
      ),
    )
  }),
}))

afterEach(() => {
  cleanup()
  vi.mocked(emitTargetCellCommit).mockClear()
})

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

const rows: CellRow[] = [
  {
    cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
    canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
    sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
  },
  {
    cellId: "cell-1", side: "target", value: "bonjour", valueHtml: null, type: "text",
    canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-target",
    sourceEventId: "cell-1-source", lastEditor: "tester", lastEditAt: 2, validated: false,
    wordCount: 1,
  },
]

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function tableElement(store: CellStore, cellLockHolders: ReadonlyMap<string, string>, onCellCommitted: (cellId: string) => void) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(EditorActionsProvider, {
      value: {},
      children: createElement(EditorTable, {
        project,
        cellStore: store,
        username: "tester",
        cellLockHolders,
        onCellCommitted,
        isCompletionConfigured: false,
        isCompletionAvailable: false,
        completing: new Map(),
        examples: new Map(),
        errors: new Map(),
        previews: new Map(),
        onCompleteSingle: () => {},
        onCompleteBatch: () => {},
        healthMap: new Map(),
        lineNumbersEnabled: false,
        cellLabelsEnabled: true,
        sourceTextDirection: "ltr",
        targetTextDirection: "ltr",
      }),
    }),
  )
}

describe("AQU-1154 — the focus lock never drops a commit", () => {
  it("hands the commit to the outbox even when presence now names another holder", async () => {
    const store = makeStore()
    const onCellCommitted = vi.fn()
    const view = render(tableElement(store, new Map(), onCellCommitted))
    await screen.findByText("hello")

    // Open the editor while the cell is free.
    const readSurface = document.querySelector('[data-editor-cell-surface="target-read"]')
    expect(readSurface).not.toBeNull()
    fireEvent.click(readSurface!)
    const pm = await waitFor(() => {
      const el = document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null
      if (!el?.editor) throw new Error("editor not mounted yet")
      return el
    })

    // The user types; meanwhile the DO dropped our lease and a peer claimed
    // the cell — presence now says "alice is editing" (label only).
    act(() => {
      pm.editor!.commands.focus("end")
      pm.editor!.commands.insertContent(" tout le monde")
    })
    view.rerender(tableElement(store, new Map([["cell-1", "alice"]]), onCellCommitted))

    // Blur flushes the pending text. The old guard returned here without
    // emitting; the commit must reach the outbox and ping the parent.
    act(() => {
      fireEvent.blur(pm)
    })
    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1))
    expect(vi.mocked(emitTargetCellCommit).mock.calls[0][0]).toMatchObject({
      cellId: "cell-1",
      value: "bonjour tout le monde",
    })
    // The parent is pinged with the just-assigned event id so revalidate runs.
    await waitFor(() => expect(onCellCommitted).toHaveBeenCalledTimes(1))
    expect(onCellCommitted.mock.calls[0].slice(0, 2)).toEqual(["cell-1", "evt-commit-1"])
  })

  it("still keeps a held cell read-only before the editor opens (advisory affordance)", async () => {
    const store = makeStore()
    render(tableElement(store, new Map([["cell-1", "alice"]]), vi.fn()))
    await screen.findByText("hello")
    const readSurface = document.querySelector('[data-editor-cell-surface="target-read"]')
    expect(readSurface?.getAttribute("aria-readonly")).toBe("true")
    fireEvent.click(readSurface!)
    expect(document.querySelector(".ProseMirror")).toBeNull()
    expect(emitTargetCellCommit).not.toHaveBeenCalled()
  })
})

// ── B4: object-identity invariant for setState bail-out ───────────────────────
//
// React's functional-updater (and direct setState) bails — skips re-render —
// when the new value is reference-equal to the current state.  The original
// ProjectWorkspace handlers for lock.claimed and lock.released mutated the
// shared Map in place *before* calling setState, so the bail check always
// fired and the UI never updated for lone lock frames.
//
// The helpers in cell-lock-state.ts always return a NEW Map.  These tests pin
// that contract so a future regression is caught immediately. The map now
// drives only the "X is editing" label and read-only affordance.

describe("B4 — cell-lock-state helpers never alias input (bail-out invariant)", () => {
  describe("applyPresenceFrame", () => {
    it("returns a new Map (never the same reference)", () => {
      const users = [{ userId: "alice", focusedCell: "GEN 1:1" }]
      const result = applyPresenceFrame(users, "bob")
      // The helper builds from scratch — there is no prior map to alias
      expect(result).toBeInstanceOf(Map)
      expect(result.get("GEN 1:1")).toBe("alice")
    })

    it("excludes the current user's focusedCell", () => {
      const users = [
        { userId: "alice", focusedCell: "GEN 1:1" },
        { userId: "me", focusedCell: "GEN 1:2" },
      ]
      const result = applyPresenceFrame(users, "me")
      expect(result.has("GEN 1:2")).toBe(false)
      expect(result.get("GEN 1:1")).toBe("alice")
    })

    it("excludes users with no focusedCell", () => {
      const users = [{ userId: "alice" }]
      const result = applyPresenceFrame(users, "bob")
      expect(result.size).toBe(0)
    })
  })

  describe("applyLockClaimed", () => {
    it("returns a Map with a different identity from the input", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockClaimed(current, "GEN 1:2", "bob")
      expect(result).not.toBe(current)
    })

    it("includes the new claim in the returned Map", () => {
      const current = new Map<string, string>()
      const result = applyLockClaimed(current, "GEN 1:1", "alice")
      expect(result.get("GEN 1:1")).toBe("alice")
    })

    it("preserves existing entries", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockClaimed(current, "GEN 1:2", "bob")
      expect(result.get("GEN 1:1")).toBe("alice")
      expect(result.get("GEN 1:2")).toBe("bob")
    })

    it("does NOT mutate the input Map (critical: prevents React bail-out)", () => {
      const current = new Map<string, string>()
      applyLockClaimed(current, "GEN 1:1", "alice")
      // The original map must remain unchanged — if it were mutated the
      // React functional updater would see the new value already in `cur`
      // and bail out, skipping the re-render.
      expect(current.size).toBe(0)
    })
  })

  describe("applyLockReleased", () => {
    it("returns a Map with a different identity from the input", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result).not.toBe(current)
    })

    it("removes the released cell from the returned Map", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result.has("GEN 1:1")).toBe(false)
    })

    it("does NOT mutate the input Map (critical: prevents React bail-out)", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      applyLockReleased(current, "GEN 1:1")
      // The original map must still contain the entry — if it were deleted
      // in-place the updater's `!cur.has(cellId)` check would bail, skipping
      // the re-render and leaving the cell visually locked forever.
      expect(current.get("GEN 1:1")).toBe("alice")
    })

    it("returns an empty Map when removing the only entry", () => {
      const current = new Map<string, string>([["GEN 1:1", "alice"]])
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result.size).toBe(0)
    })

    it("returns a map without the entry even if it was absent (idempotent)", () => {
      const current = new Map<string, string>()
      const result = applyLockReleased(current, "GEN 1:1")
      expect(result.has("GEN 1:1")).toBe(false)
      expect(result).not.toBe(current)
    })
  })

  describe("frame sequence: presence -> lock.claimed -> lone lock.released", () => {
    // This is the exact sequence from the B4 bug report.
    // The sweep-expired-leases path broadcasts lock.released with NO trailing
    // presence frame.  If lock.released mutated the shared Map in place, the
    // React bail-out would fire and the cell would stay visually locked.

    it("produces distinct Map objects on every step (no object aliasing)", () => {
      // Step 1: presence frame
      const afterPresence = applyPresenceFrame(
        [{ userId: "alice", focusedCell: "GEN 1:1" }],
        "me",
      )
      expect(afterPresence.get("GEN 1:1")).toBe("alice")

      // Step 2: lock.claimed (alice explicitly claims GEN 1:1)
      const afterClaimed = applyLockClaimed(afterPresence, "GEN 1:1", "alice")
      expect(afterClaimed).not.toBe(afterPresence) // new identity → re-render fires
      expect(afterClaimed.get("GEN 1:1")).toBe("alice")

      // Step 3: lone lock.released (lease sweep — no trailing presence frame)
      const afterReleased = applyLockReleased(afterClaimed, "GEN 1:1")
      expect(afterReleased).not.toBe(afterClaimed) // new identity → re-render fires
      expect(afterReleased.has("GEN 1:1")).toBe(false)

      // Critically: the intermediate maps are unchanged
      expect(afterPresence.get("GEN 1:1")).toBe("alice") // step-1 map untouched
      expect(afterClaimed.get("GEN 1:1")).toBe("alice")  // step-2 map untouched
    })
  })
})
