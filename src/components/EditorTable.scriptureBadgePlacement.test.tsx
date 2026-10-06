/**
 * AQU-1716: where the scripture "verse" badge sits.
 *
 * AQU-1285 gave a partner scripture row a sky accent plus a small "verse"
 * badge, and pinned the badge to the row's TOP-RIGHT corner — the same corner
 * as the row's "…" menu. On a translated Biblica file the two crowded each
 * other and another control painted over the badge's text ("ve●se"). The badge
 * now sits at the row's FOOT instead.
 *
 * The guard is that the badge is a FLOW element at the end of the row rather
 * than an `absolute` corner pin. That is the property the acceptance criteria
 * actually turn on: the row's foot already carries the AI-draft progress bar
 * and the last line of translation text, and an overlay at the bottom corner
 * lands on top of both as soon as a verse's last line runs the cell's full
 * width. In flow it cannot, at any row height or viewport.
 *
 * This lives in the GENERIC editor tests, with the partner registry mocked —
 * the badge is drawn by the editor table for any row a partner reports as
 * scripture (see AQU-1286: deleting `src/partner-integrations/` must leave the
 * app and its guards standing), so the guard must not live in a partner folder.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "@/components/EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

// A stand-in partner: any cell carrying `{ scriptureFixture: true }` reads as
// that partner's Bible text. Keeps the guard independent of whether any real
// partner folder is present in the tree.
vi.mock("@/lib/partners/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/partners/registry")>()
  return {
    ...actual,
    isPartnerScriptureCell: (metadata: unknown) =>
      typeof metadata === "object" && metadata !== null
      && (metadata as Record<string, unknown>).scriptureFixture === true,
  }
})

// happy-dom has no layout engine, so the real LegendList may decide no rows are
// visible. Render every row instead (same stand-in as the other table tests).
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
        getState: () => ({
          scroll: 0,
          positionAtIndex: (index: number) => index * 140,
          sizeAtIndex: () => 140,
        }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))

      return React.createElement(
        "div",
        null,
        data.map((item, index) => (
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          )
        )),
      )
    }),
  }
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

const SCRIPTURE_METADATA: Record<string, unknown> = { scriptureFixture: true }

function makeStore(metadataById: ReadonlyMap<string, Record<string, unknown>>): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  const rows: CellRow[] = [...metadataById.keys()].flatMap((id, i) => [
    {
      cellId: id,
      side: "source",
      value: `source ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${i + 1}`,
      anchorCellId: null,
      eventId: `${id}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
      metadata: metadataById.get(id) ?? {},
    },
    {
      cellId: id,
      side: "target",
      value: `target ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${i + 1}`,
      anchorCellId: null,
      eventId: `${id}-target`,
      sourceEventId: `${id}-source`,
      lastEditor: "tester",
      lastEditAt: 2,
      validated: false,
      wordCount: 1,
    },
  ] satisfies CellRow[])
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(cellStore: CellStore) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={cellStore}
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
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — the scripture badge sits at the row's foot (AQU-1716)", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("dir")
  })

  it("puts the badge after all of the row's content, not in the top-right corner", async () => {
    renderTable(makeStore(new Map([["verse-1", SCRIPTURE_METADATA]])))
    await screen.findByText("target 0")

    const row = document.querySelector('[data-cell-id="verse-1"]')
    expect(row).toHaveAttribute("data-cell-kind", "scripture")

    const badgeRow = row?.querySelector('[data-testid="scripture-badge-row"]')
    expect(badgeRow).toBeInTheDocument()
    expect(badgeRow?.textContent?.trim()).toBe("verse")

    // At the FOOT of the row: the last thing in it, after the cell's grid.
    expect(badgeRow).toBe(row?.lastElementChild)
  })

  it("keeps the badge in flow so it cannot overlay the text or the draft bar", async () => {
    renderTable(makeStore(new Map([["verse-1", SCRIPTURE_METADATA]])))
    await screen.findByText("target 0")

    const row = document.querySelector('[data-cell-id="verse-1"]')
    const badgeRow = row?.querySelector('[data-testid="scripture-badge-row"]')

    // Not an overlay — an overlay at the bottom corner is exactly what would
    // land on a full-width last line of translation, and on the AI-draft
    // progress bar pinned to the target well's bottom.
    expect(badgeRow?.className).not.toContain("absolute")
    // No top anchor left behind: the top-right corner is the "…" menu's.
    expect(badgeRow?.className).not.toMatch(/\btop-/)
    // Logical end alignment, so an RTL UI language mirrors it to bottom-LEFT
    // without a second rule — `right-*` would pin it to the wrong side.
    expect(badgeRow?.className).toContain("justify-end")
    expect(badgeRow?.className).not.toMatch(/\bright-/)
  })

  it("leaves non-scripture rows unbadged", async () => {
    renderTable(makeStore(new Map([
      ["verse-1", SCRIPTURE_METADATA],
      ["note-1", {}],
    ])))
    await screen.findByText("target 0")

    expect(document.querySelector('[data-cell-id="note-1"]'))
      .not.toHaveAttribute("data-cell-kind")
    expect(
      document.querySelector('[data-cell-id="note-1"]')
        ?.querySelector('[data-testid="scripture-badge-row"]'),
    ).toBeNull()
    expect(screen.getAllByText("verse")).toHaveLength(1)
  })
})
