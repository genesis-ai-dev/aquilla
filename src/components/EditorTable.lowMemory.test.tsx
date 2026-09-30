/**
 * AQU-1191: low-memory mode drops a row's per-cell presence subscription, and
 * with it the peer chips and the mirrored remote draft. Those chips were the
 * ONLY thing on a row that named who holds a cell — `heldByLabel` makes the
 * editor read-only but renders no label at all (see
 * TranslatedEditor.commit.test.tsx). Dialing them back therefore handed a
 * translator a silently uneditable cell: read-only, no reason, no name.
 *
 * The QA bot walk on PR #897 caught exactly that, because the original unit
 * tests covered the preference store rather than the row render. These cases
 * sit at the level where it escaped: a real EditorTable with a real presence
 * store and a held lock, asserting that the identification survives the mode
 * even though the conveniences do not.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { createProjectPresenceStore, type ProjectPresenceStore } from "@/lib/sync/presence-store"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { setLowMemoryMode, __resetLowMemoryForTests } from "@/lib/perf/low-memory"

// happy-dom has no real layout engine, so LegendList may decide no rows are
// visible. Replace it with a trivial "render every row" stand-in.
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: string[]
      renderItem: (props: { item: string; index: number }) => ReactNode
      keyExtractor?: (item: string, index: number) => string
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))
      return React.createElement(
        "div",
        null,
        data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          ),
        ),
      )
    }),
  }
})

beforeEach(() => {
  localStorage.clear()
  __resetLowMemoryForTests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setLowMemoryMode("auto")
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

const OLD_TEXT = "bonjour"
const NEW_TEXT = "bonjour tout le monde"

function makeRows(target: { value: string; eventId: string }): CellRow[] {
  return [
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: "cell-1", side: "target", value: target.value, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: target.eventId,
      sourceEventId: "cell-1-source", lastEditor: "alice", lastEditAt: 2, validated: false,
      wordCount: 1,
    },
  ]
}

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows({ value: OLD_TEXT, eventId: "cell-1-target-1" }), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(
  store: CellStore,
  presence: ProjectPresenceStore,
  cellLockHolders?: ReadonlyMap<string, string>,
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={store}
          username="tester"
          presenceStore={presence}
          cellLockHolders={cellLockHolders}
          isCompletionConfigured={false}
          isCompletionAvailable={false}
          completing={new Map()}
          examples={new Map()}
          errors={new Map()}
          previews={new Map()}
          onCompleteSingle={() => {}}
          onCompleteBatch={() => {}}
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

/** Alice focused in cell-1 publishing `draftText`, or gone when `draftText` is null. */
function aliceFrame(presence: ProjectPresenceStore, draftText: string | null) {
  act(() => {
    presence.applyPresenceFrame(draftText === null ? [] : [{
      userId: "alice",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: draftText.length, head: draftText.length, draftText },
      ts: Date.now(),
    }])
  })
}

/** Alice's commit lands in this client's projection. */
function landCommit(store: CellStore, value: string) {
  act(() => {
    store.replaceRows(makeRows({ value, eventId: "cell-1-target-2" }), { full: true, maxServerSeq: 2 })
  })
}

const overlay = () => document.querySelector("[data-remote-presence-draft]")

async function setup(cellLockHolders?: ReadonlyMap<string, string>) {
  const store = makeStore()
  const presence = createProjectPresenceStore("tester")
  renderTable(store, presence, cellLockHolders)
  await screen.findByText(OLD_TEXT)
  return { store, presence }
}

/** Alice holds the advisory focus lease on cell-1, as the project DO reports it. */
const ALICE_HOLDS_CELL_1: ReadonlyMap<string, string> = new Map([["cell-1", "Alice"]])

const presenceBadge = () => document.querySelector("[data-cell-presence]")
const lockHolder = () => document.querySelector("[data-cell-lock-holder]")

describe("EditorTable — AQU-1191 low-memory mode keeps the contention signal", () => {
  it("shows the peer chips and the draft mirror at the full tier, and no standalone lock label", async () => {
    const { presence } = await setup(ALICE_HOLDS_CELL_1)

    aliceFrame(presence, NEW_TEXT)

    // The chips already name her, so the fallback label would be a duplicate.
    expect(presenceBadge()).not.toBeNull()
    expect(overlay()?.textContent).toBe(NEW_TEXT)
    expect(lockHolder()).toBeNull()
  })

  it("drops the peer chips in low-memory mode but still NAMES the lock holder", async () => {
    const { presence } = await setup(ALICE_HOLDS_CELL_1)
    aliceFrame(presence, NEW_TEXT)
    expect(presenceBadge()).not.toBeNull()

    act(() => setLowMemoryMode("on"))

    // The convenience goes...
    expect(presenceBadge()).toBeNull()
    // ...but the reason the cell is read-only does not. This is the assertion
    // the QA bot walk on PR #897 found missing from the shipped behaviour: the
    // chips were the only thing naming the holder, so dialing them back left a
    // silently uneditable cell.
    expect(lockHolder()).not.toBeNull()
    expect(lockHolder()?.textContent).toContain("Alice")
  })

  it("does NOT resurrect stale text when the mode is switched on mid-edit (AQU-1154 I4)", async () => {
    // Entering low-memory mode empties this row's peer list, which is the same
    // shape as a peer leaving — so AQU-1154's hold applies and the mirror keeps
    // the NEWER text until the row's own text catches up. Snapping the overlay
    // away here would put Alice's PRE-edit text back on screen, which is the
    // exact bug AQU-1154 fixed. Pinned so nobody "tidies" this into a force-clear.
    const { store, presence } = await setup(ALICE_HOLDS_CELL_1)
    aliceFrame(presence, NEW_TEXT)

    act(() => setLowMemoryMode("on"))

    expect(overlay()?.textContent).toBe(NEW_TEXT)
    expect(screen.queryByText(OLD_TEXT)).toBeNull()

    // Her commit lands: the row is the truth now and the mirror steps aside.
    landCommit(store, NEW_TEXT)
    expect(overlay()).toBeNull()
  })

  it("mirrors no FURTHER drafts once the mode is on — the subscription is gone", async () => {
    const { presence } = await setup(ALICE_HOLDS_CELL_1)
    aliceFrame(presence, NEW_TEXT)
    act(() => setLowMemoryMode("on"))

    // A new keystroke from Alice after the mode is on must not reach this row.
    aliceFrame(presence, `${NEW_TEXT} encore`)

    expect(overlay()?.textContent).not.toContain("encore")
  })

  it("restores the chips when the mode is turned off, with no reload", async () => {
    const { presence } = await setup(ALICE_HOLDS_CELL_1)
    aliceFrame(presence, NEW_TEXT)
    act(() => setLowMemoryMode("on"))
    expect(presenceBadge()).toBeNull()

    act(() => setLowMemoryMode("off"))

    expect(presenceBadge()).not.toBeNull()
    expect(overlay()?.textContent).toBe(NEW_TEXT)
    // The chips name her again, so the standalone label stands down.
    expect(lockHolder()).toBeNull()
  })

  it("names nobody when no peer holds the cell — the label is the lock, not the mode", async () => {
    // Low-memory mode on, but the cell is free: a row must not sprout an
    // "is editing" label just because the mode is active.
    await setup(new Map())
    act(() => setLowMemoryMode("on"))

    expect(lockHolder()).toBeNull()
    expect(presenceBadge()).toBeNull()
  })
})
