/**
 * AQU-1422: "Hide cell" / "Show cell" in the source cell's three-dot menu.
 *
 * The rules pinned here, and why each one earns a test:
 *
 *   - THE ENTRY IS ABSENT, NOT DISABLED, BELOW THE GATE. This is the one place
 *     the menu departs from round 4's render-it-disabled rule, and it has to:
 *     `sourceReadOnlyReason` is set by a DCS pin for EVERY role, so mirroring
 *     the Edit-text entry's condition would have drawn "Hide cell", disabled and
 *     explained, to a contributor on any pinned project. A reader must not learn
 *     that hiding exists, let alone that this file has something parked.
 *   - AN IDML ROW IS PARKABLE, even though it refuses Edit text. Hiding does not
 *     touch the protected text or the package locator; it only stops the row
 *     being offered for translation. This is the easiest rule to lose in a later
 *     refactor that reaches for `canEditSourceForCell`.
 *   - A DCS PIN DISABLES IT WITH THE SAME REASON Edit text shows, for a lead who
 *     otherwise could. That is a row-level, explicable refusal.
 *   - THE WORDING FLIPS on a parked cell, and only a parked cell that reached the
 *     table (i.e. revealed) carries the eye-off badge.
 *
 * The store's own filtering — a parked row leaving the text table, the media
 * lens and the navigation counts together — is covered in
 * `useActiveCellStore.hiddenCells.test.ts`, where it can be asserted directly
 * rather than through a rendered list.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { DCS_SOURCE_LOCK_REASON } from "@/hooks/useProjectPermissions"
import { ROLE } from "@/lib/sync/role-policy"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// The table asks this to decide whether the source lane is pinned upstream, and
// it reports `loading: true` on its first render — which the capabilities hook
// treats as LOCKED (default-locked, so a doomed edit is never offered). Left
// real, every assertion below would depend on how far a fetch happened to get.
const dcsCursor = vi.hoisted(() => ({ value: { cursor: null as string | null, loading: false } }))
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => dcsCursor.value,
}))

// happy-dom has no layout engine — render every row.
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
          React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
        ),
      )
    }),
  }
})

const baseProject: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

const projectAt = (level: number): ProjectRecord =>
  ({ ...baseProject, syncRole: { level } }) as ProjectRecord

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  over: Partial<CellRow> = {},
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: "text",
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${cellId}-${side}`,
    sourceEventId: side === "target" ? `${cellId}-source` : null,
    lastEditor: null,
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    ...over,
  } as CellRow
}

/** One plain text cell. `showHidden` decides whether a parked one renders at
 *  all — the store drops it from the display list otherwise, which is the
 *  production behaviour and not something to bypass here. */
function makeStore(opts: { hidden?: boolean; showHidden?: boolean; metadata?: Record<string, unknown> } = {}): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: baseProject.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
    showHidden: opts.showHidden ?? false,
  })
  store.replaceRows(
    [
      row("cue-a", "source", "First cue", {
        ...(opts.hidden ? { hidden: true } : {}),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      }),
      row("cue-a", "target", "premiere"),
    ],
    { full: true, maxServerSeq: 1 },
  )
  return store
}

function renderTable(
  over: Partial<Parameters<typeof EditorTable>[0]> = {},
  actions: Parameters<typeof EditorActionsProvider>[0]["value"] = {},
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={actions}>
        <EditorTable
          project={projectAt(ROLE.PROJECT_LEAD)}
          cellStore={makeStore()}
          username="tester"
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
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
          {...over}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

const rowEl = (cellId: string) => document.querySelector(`[data-cell-id="${cellId}"]`) as HTMLElement
/** The GRID row inside the cell wrapper — the element the dim and the hidden
 *  state ride, because it is the one that spans source, target and gutter. */
const gridEl = (cellId: string) => rowEl(cellId).querySelector("[data-grid-row]") as HTMLElement
const openMenu = (cellId: string) => {
  fireEvent.click(within(rowEl(cellId)).getByTestId(`cell-menu-${cellId}`))
}
/** Menus are a popup layer, so entries are found on `screen`, not in the row. */
const hiddenEntry = () => screen.findByTestId("cell-menu-toggle-hidden")

/** An IDML cell, whose source text is protected. Mirrors the shape the table
 *  reads to decide that — see `idmlConfiguration` in EditorTable. */
const IDML_METADATA = {
  idml: { version: 2, storyId: "story-1", paragraphIndex: 0, spanIds: ["s1"] },
}

describe("EditorTable — Hide cell / Show cell", () => {
  it("offers it to a project lead when the source is editable", async () => {
    renderTable({}, { onSetCellHidden: () => {} })
    await screen.findByText("First cue")

    openMenu("cue-a")
    const item = await hiddenEntry()
    expect(item.textContent).toContain("Hide cell")
    expect(item).not.toHaveAttribute("data-disabled")
  })

  it("calls the handler with the cell and the new state", async () => {
    const onSetCellHidden = vi.fn()
    renderTable({}, { onSetCellHidden })
    await screen.findByText("First cue")

    openMenu("cue-a")
    fireEvent.click(await hiddenEntry())

    expect(onSetCellHidden).toHaveBeenCalledWith("cue-a", true)
  })

  it("is ABSENT for a contributor — not disabled, absent", async () => {
    // The whole point of the departure from the render-it-disabled rule. A
    // reader must not learn hiding exists here.
    renderTable({ project: projectAt(ROLE.CONTRIBUTOR), cellStore: makeStore() }, { onSetCellHidden: () => {} })
    await screen.findByText("First cue")

    // A contributor on an editable untimed file has nothing else to offer
    // either, so the trigger itself does not render.
    expect(screen.queryByTestId("cell-menu-cue-a")).toBeNull()
    expect(screen.queryByTestId("cell-menu-toggle-hidden")).toBeNull()
  })

  it("stays absent for a contributor even on a DCS-pinned project, where a reason exists", async () => {
    // `sourceReadOnlyReason` is non-null for the pin at EVERY role. This is the
    // regression that mirroring Edit text's condition would have introduced.
    dcsCursor.value = { cursor: "abc123", loading: false }
    try {
      renderTable({ project: projectAt(ROLE.CONTRIBUTOR), cellStore: makeStore() }, { onSetCellHidden: () => {} })
      await screen.findByText("First cue")
      expect(screen.queryByTestId("cell-menu-toggle-hidden")).toBeNull()
    } finally {
      dcsCursor.value = { cursor: null, loading: false }
    }
  })

  it("is drawn DISABLED with the pin's reason for a lead on a DCS-pinned project", async () => {
    dcsCursor.value = { cursor: "abc123", loading: false }
    try {
      renderTable({}, { onSetCellHidden: () => {} })
      await screen.findByText("First cue")

      openMenu("cue-a")
      const item = await hiddenEntry()
      expect(item).toHaveAttribute("data-disabled")
      // The SAME string Edit text shows — one reason, so the two entries cannot
      // drift into telling a lead different stories about one pin.
      expect(
        within(item).getByTestId("cell-menu-toggle-hidden-reason").textContent,
      ).toBe(DCS_SOURCE_LOCK_REASON)
    } finally {
      dcsCursor.value = { cursor: null, loading: false }
    }
  })

  it("is offered on an IDML row, which refuses Edit text", async () => {
    renderTable(
      { cellStore: makeStore({ metadata: IDML_METADATA }) },
      { onSetCellHidden: () => {} },
    )
    await screen.findByText("First cue")

    openMenu("cue-a")
    // Edit text is disabled here — the package locator depends on the text.
    expect(await screen.findByTestId("cell-menu-edit-source")).toHaveAttribute("data-disabled")
    // Hiding touches neither, so it is live.
    const item = await hiddenEntry()
    expect(item).not.toHaveAttribute("data-disabled")
    expect(item.textContent).toContain("Hide cell")
  })

  it("renders nothing when no handler is wired at all", async () => {
    // A local project, or any surface that does not offer parking: the entry
    // must not appear as a dead item.
    renderTable()
    await screen.findByText("First cue")
    if (screen.queryByTestId("cell-menu-cue-a")) openMenu("cue-a")
    expect(screen.queryByTestId("cell-menu-toggle-hidden")).toBeNull()
  })
})

describe("EditorTable — a revealed parked row", () => {
  it("reads 'Show cell', is dimmed, and carries the eye-off badge", async () => {
    renderTable(
      { cellStore: makeStore({ hidden: true, showHidden: true }) },
      { onSetCellHidden: () => {} },
    )
    await screen.findByText("First cue")

    const grid = gridEl("cue-a")
    expect(grid).toHaveAttribute("data-cell-hidden", "true")
    expect(grid.className).toContain("opacity-60")
    expect(within(grid).getByTestId("source-cell-hidden-badge")).toBeTruthy()

    openMenu("cue-a")
    expect((await hiddenEntry()).textContent).toContain("Show cell")
  })

  it("asks for the cell to come back", async () => {
    const onSetCellHidden = vi.fn()
    renderTable(
      { cellStore: makeStore({ hidden: true, showHidden: true }) },
      { onSetCellHidden },
    )
    await screen.findByText("First cue")

    openMenu("cue-a")
    fireEvent.click(await hiddenEntry())

    expect(onSetCellHidden).toHaveBeenCalledWith("cue-a", false)
  })

  it("does not render at all while the reveal is off — and so carries no badge", async () => {
    renderTable(
      { cellStore: makeStore({ hidden: true, showHidden: false }) },
      { onSetCellHidden: () => {} },
    )
    // The store drops it from the display list, so there is no row and nothing
    // for a permission check on the badge to protect.
    expect(screen.queryByText("First cue")).toBeNull()
    expect(screen.queryByTestId("source-cell-hidden-badge")).toBeNull()
  })
})
