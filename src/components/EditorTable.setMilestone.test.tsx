/**
 * AQU-2308: "Set a new milestone…" in the source cell's three-dot menu.
 *
 * What is pinned here, and why each one earns a test:
 *
 *   - THE ENTRY IS ABSENT, NOT DISABLED, BELOW THE GATE — and the gate is a
 *     rung ABOVE the park/edit-source one. Naming a range relayouts the
 *     navigator for everyone who opens the file, which is why the event sits at
 *     MAINTAINER; a project lead who may park and remove rows still does not
 *     see this. That off-by-one-rung is the easiest thing for a later refactor
 *     to "simplify" into `canEditSource`.
 *   - A LIVE-LINKED DOWNSTREAM PROJECT SHOWS IT TO NOBODY, maintainer included.
 *     Its divisions are mirrored from upstream, so there is nothing to name.
 *   - IT IS NOT GATED ON `canEditSource`, which a DCS pin forces false for
 *     every role. A pin protects the source TEXT; which divisions a file is
 *     navigated by is still this project's own business, so a maintainer on a
 *     pinned project keeps the entry.
 *   - The row hands over only its own cell id. Resolving the other edge needs
 *     the file's cell order, which lives in the workspace.
 *
 * The dialog the entry opens — its pickers and every refusal — is covered in
 * `editor/SetMilestoneDialog.test.tsx`, where it can be driven directly.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { ROLE } from "@/lib/sync/role-policy"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// Left real, every assertion would depend on how far a fetch happened to get:
// the hook reports `loading: true` first, which the capabilities hook treats as
// locked. Also the lever for the DCS case below.
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

const projectAt = (level: number, over: Partial<ProjectRecord> = {}): ProjectRecord =>
  ({ ...baseProject, syncRole: { level }, ...over }) as ProjectRecord

function row(cellId: string, side: "source" | "target", value: string): CellRow {
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
  } as CellRow
}

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: baseProject.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(
    [row("line-a", "source", "First line"), row("line-a", "target", "premiere")],
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
          project={projectAt(ROLE.MAINTAINER)}
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
const openMenu = (cellId: string) => {
  fireEvent.click(within(rowEl(cellId)).getByTestId(`cell-menu-${cellId}`))
}
/** Menus are a popup layer, so entries are found on `screen`, not in the row. */
const entry = () => screen.findByTestId("cell-menu-set-milestone")
const noEntry = () => screen.queryByTestId("cell-menu-set-milestone")

describe("EditorTable — Set a new milestone…", () => {
  it("offers it to a maintainer", async () => {
    renderTable({}, { onSetMilestone: () => {} })
    await screen.findByText("First line")

    openMenu("line-a")
    const item = await entry()
    expect(item.textContent).toContain("Set a new milestone")
    expect(item).not.toHaveAttribute("data-disabled")
  })

  it("hands the workspace the cell the menu was opened on, and nothing else", async () => {
    const onSetMilestone = vi.fn()
    renderTable({}, { onSetMilestone })
    await screen.findByText("First line")

    openMenu("line-a")
    fireEvent.click(await entry())
    expect(onSetMilestone).toHaveBeenCalledWith("line-a")
    expect(onSetMilestone).toHaveBeenCalledTimes(1)
  })

  it("hides it from a project lead, who may still park and remove rows", async () => {
    renderTable({ project: projectAt(ROLE.PROJECT_LEAD) }, {
      onSetMilestone: () => {},
      onSetCellHidden: () => {},
    })
    await screen.findByText("First line")

    openMenu("line-a")
    // The menu itself is open and holding the lead's own actions, so this is
    // the entry being absent rather than the menu failing to open.
    await screen.findByTestId("cell-menu-toggle-hidden")
    expect(noEntry()).toBeNull()
  })

  it("hides it from a contributor — who is left with no menu at all here", async () => {
    renderTable({ project: projectAt(ROLE.CONTRIBUTOR) }, { onSetMilestone: () => {} })
    await screen.findByText("First line")

    // Nothing else on this row is theirs either, so the menu's own
    // "nothing to offer ⇒ no button" rule applies — which is the thing a new
    // always-present entry would silently have broken.
    expect(within(rowEl("line-a")).queryByTestId("cell-menu-line-a")).toBeNull()
    expect(noEntry()).toBeNull()
  })

  it("hides it from everyone on a live-linked downstream project", async () => {
    renderTable({ project: projectAt(ROLE.MAINTAINER, { sourceLinkMode: "live" }) }, {
      onSetMilestone: () => {},
    })
    await screen.findByText("First line")

    expect(within(rowEl("line-a")).queryByTestId("cell-menu-line-a")).toBeNull()
    expect(noEntry()).toBeNull()
  })

  it("keeps it for a maintainer on a DCS-pinned project", async () => {
    // A pin protects the source TEXT. It says nothing about which divisions the
    // file is navigated by, so gating this on `canEditSource` would be wrong.
    dcsCursor.value = { cursor: "abc123", loading: false }
    try {
      renderTable({}, { onSetMilestone: () => {} })
      await screen.findByText("First line")

      openMenu("line-a")
      expect((await entry()).textContent).toContain("Set a new milestone")
    } finally {
      dcsCursor.value = { cursor: null, loading: false }
    }
  })

  it("draws no entry when the workspace offers no handler", async () => {
    // The menu still opens on the maintainer's other actions, so this is the
    // entry being absent and not the menu being gone.
    renderTable({}, {})
    await screen.findByText("First line")

    openMenu("line-a")
    await screen.findByTestId("cell-menu-edit-source")
    expect(noEntry()).toBeNull()
  })
})
