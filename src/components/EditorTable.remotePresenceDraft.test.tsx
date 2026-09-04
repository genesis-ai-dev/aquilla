/**
 * AQU-1154: the remote-presence draft overlay must never replace newer text
 * with older (invariant I4).
 *
 * While a peer is focused in a cell, their live editor text is published as
 * `selection.draftText` and rendered over this row's own text. Their commit
 * reaches this client seconds later on a slow link, so snapping back to the
 * row the moment they blur showed the PRE-edit text. The overlay therefore
 * holds the peer's last non-empty draft after they leave until the row's own
 * text catches up (or a bounded timeout), and an empty draft never blanks a
 * cell that has text.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable, REMOTE_DRAFT_HOLD_MS } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { createProjectPresenceStore, type ProjectPresenceStore } from "@/lib/sync/presence-store"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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

function renderTable(store: CellStore, presence: ProjectPresenceStore) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={store}
          username="tester"
          presenceStore={presence}
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

async function setup() {
  const store = makeStore()
  const presence = createProjectPresenceStore("tester")
  renderTable(store, presence)
  await screen.findByText(OLD_TEXT)
  return { store, presence }
}

describe("EditorTable — AQU-1154 remote draft overlay never shows older text", () => {
  it("keeps the peer's last draft after they leave until the row's own text catches up", async () => {
    const { store, presence } = await setup()

    aliceFrame(presence, NEW_TEXT)
    expect(overlay()?.textContent).toBe(NEW_TEXT)
    expect(screen.queryByText(OLD_TEXT)).toBeNull()

    // Alice blurs; her commit has not reached us yet. The row still says the
    // old text — that must NOT come back.
    aliceFrame(presence, null)
    expect(overlay()?.textContent).toBe(NEW_TEXT)
    expect(screen.queryByText(OLD_TEXT)).toBeNull()

    // Her commit lands: the row is now the truth and the overlay steps aside.
    landCommit(store, NEW_TEXT)
    expect(overlay()).toBeNull()
    expect(screen.getByText(NEW_TEXT)).toBeTruthy()
  })

  it("hides the held draft once the row updates, even to different text", async () => {
    const { store, presence } = await setup()
    aliceFrame(presence, NEW_TEXT)
    aliceFrame(presence, null)
    expect(overlay()?.textContent).toBe(NEW_TEXT)

    // A newer projection (e.g. a later edit by someone else) supersedes the
    // held draft — the overlay must not outlive fresher row text.
    landCommit(store, "salut")
    expect(overlay()).toBeNull()
    expect(screen.getByText("salut")).toBeTruthy()
  })

  it("never blanks a cell with an empty remote draft", async () => {
    const { presence } = await setup()

    aliceFrame(presence, "")
    expect(overlay()).toBeNull()
    expect(screen.getByText(OLD_TEXT)).toBeTruthy()

    // Typing resumes → overlay; select-all-delete again → back to the last
    // non-empty draft rather than a blank cell.
    aliceFrame(presence, NEW_TEXT)
    expect(overlay()?.textContent).toBe(NEW_TEXT)
    aliceFrame(presence, "")
    expect(overlay()?.textContent).toBe(NEW_TEXT)
  })

  it("drops the held draft after the bounded hold if the row never updates", async () => {
    const { presence } = await setup()
    aliceFrame(presence, NEW_TEXT)
    vi.useFakeTimers()
    aliceFrame(presence, null)
    expect(overlay()?.textContent).toBe(NEW_TEXT)

    act(() => {
      vi.advanceTimersByTime(REMOTE_DRAFT_HOLD_MS - 1)
    })
    expect(overlay()?.textContent).toBe(NEW_TEXT)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(overlay()).toBeNull()
    expect(screen.getByText(OLD_TEXT)).toBeTruthy()
  })

  it("re-baselines when the row updates while the peer is still typing", async () => {
    const { store, presence } = await setup()
    aliceFrame(presence, "bonjour tout")
    // Alice's idle commit lands mid-edit; she keeps typing past it.
    landCommit(store, "bonjour tout")
    aliceFrame(presence, NEW_TEXT)
    expect(overlay()?.textContent).toBe(NEW_TEXT)

    // She leaves before the final commit lands: the newer draft stays up over
    // the (older) mid-edit projection.
    aliceFrame(presence, null)
    expect(overlay()?.textContent).toBe(NEW_TEXT)
  })
})
