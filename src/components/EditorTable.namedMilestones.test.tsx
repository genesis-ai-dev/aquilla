/**
 * AQU-2310: a hand-set milestone nested under a chapter is LISTED, on every
 * file — not just IDML.
 *
 * AQU-2308 derived "The calming of the storm" as a named sub-entry of Mark 4,
 * but the table only ever handed subsections to the navigator for IDML files,
 * so on a Scripture file it never appeared and could not be renamed, re-ranged
 * or removed. What is pinned here:
 *
 *   - the nested milestone is a row of its own, under its chapter, with the
 *     edit control; the chapter row has none;
 *   - picking it goes to ITS first line, not the chapter's;
 *   - the chapter stays a destination of its own (it is not turned into an
 *     expander whose only child is the milestone).
 */

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { ROLE } from "@/lib/sync/role-policy"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { FileMilestone } from "../../db/shared/file-milestones"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
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

const project = {
  id: "proj-1",
  name: "Mark",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  syncRole: { level: ROLE.MAINTAINER },
} as unknown as ProjectRecord

const CELLS = [
  { id: "m3-1", ref: "MRK 3:1" },
  { id: "m4-1", ref: "MRK 4:1" },
  { id: "m4-35", ref: "MRK 4:35" },
  { id: "m4-41", ref: "MRK 4:41" },
  { id: "m5-1", ref: "MRK 5:1" },
] as const

const CALMING: FileMilestone = {
  id: "m-calm",
  name: "The calming of the storm",
  startCellId: "m4-35",
  endCellId: "m4-41",
}

function makeStore(): CellStore {
  const rows: CellRow[] = CELLS.map(({ id, ref }) => ({
    cellId: id, side: "source", value: `${ref} text`, valueHtml: null, type: "text",
    canonicalRef: ref, anchorCellId: null, eventId: `${id}-source`, sourceEventId: null,
    lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
  }) as CellRow)
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
    userMilestones: [CALMING],
  })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(onNavigateToCell: (cellId: string) => void) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
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
          onNavigateToCell={onNavigateToCell}
          milestoneEditing={{ onAction: vi.fn(), onNew: vi.fn() }}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

const option = (text: string) => {
  const found = screen.getAllByRole("option").find((el) => el.textContent?.includes(text))
  if (!found) throw new Error(`no option ${text}`)
  return found
}

const openNavigator = async () => {
  fireEvent.click(await screen.findByRole("combobox", { name: /Current chapter/ }))
}

describe("EditorTable — a hand-set milestone nested under a chapter (AQU-2310)", () => {
  it("lists it under its chapter, with the edit control; the chapter has none", async () => {
    renderTable(() => {})
    await openNavigator()

    const labels = screen.getAllByRole("option").map((el) => el.textContent ?? "")
    const mark4 = labels.findIndex((text) => text.includes("Mark 4"))
    expect(labels[mark4 + 1]).toContain("The calming of the storm")
    expect(within(option("The calming of the storm")).getByTestId("milestone-row-edit"))
      .toBeInTheDocument()
    expect(within(option("Mark 4")).queryByTestId("milestone-row-edit")).toBeNull()
  })

  it("goes to the milestone's own first line when picked", async () => {
    const onNavigateToCell = vi.fn()
    renderTable(onNavigateToCell)
    await openNavigator()

    fireEvent.click(option("The calming of the storm"))
    expect(onNavigateToCell).toHaveBeenLastCalledWith("m4-35")
  })

  it("keeps the chapter itself a destination", async () => {
    const onNavigateToCell = vi.fn()
    renderTable(onNavigateToCell)
    await openNavigator()

    fireEvent.click(option("Mark 4"))
    expect(onNavigateToCell).toHaveBeenLastCalledWith("m4-1")
  })
})
