/**
 * AQU-1041: a cell whose target is an untouched AI draft must render its header
 * exactly like a human-typed draft — no "AI draft · review required" tag.
 *
 * Regression guard: the header used to render an amber `Badge` gated on
 * `cell.aiDrafted`. Removing the tag is display-only — the `aiDrafted`
 * provenance itself must survive, because the org overview's AI-drafted stat
 * and the selection bar's bulk-validate eligibility both read it. So this file
 * asserts both halves: nothing AI-flavoured is visible on the cell, AND the
 * provenance is still on the store's cell view.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { en } from "@/lib/i18n/messages/en"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

/** The badge keys are plain (non-plural) messages; narrow for the DOM matchers. */
const message = (key: "editor.ai.draftBadge" | "editor.ai.draftBadgeAria"): string =>
  en[key] as string

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

afterEach(cleanup)

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

function makeRows(aiDrafted: boolean): CellRow[] {
  return [
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: "cell-1", side: "target", value: "bonjour", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-target",
      sourceEventId: "cell-1-source", lastEditor: "tester", lastEditAt: 2, validated: false,
      wordCount: 1, aiDrafted,
    },
  ]
}

function makeStore(aiDrafted: boolean): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(aiDrafted), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(store: CellStore) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={store}
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
          cellLabelsEnabled
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — AQU-1041 no AI-draft tag on the cell", () => {
  it("renders no AI-draft tag for an untouched AI draft", async () => {
    renderTable(makeStore(true))
    await screen.findByText("hello")

    expect(screen.queryByText(message("editor.ai.draftBadge"))).toBeNull()
    expect(screen.queryByLabelText(message("editor.ai.draftBadgeAria"))).toBeNull()
    // Nothing else on the cell may reintroduce the tag under another string.
    expect(document.body.textContent).not.toMatch(/review required/i)
  })

  it("keeps the aiDrafted provenance that bulk-validate and the org stats read", async () => {
    const store = makeStore(true)
    renderTable(store)
    await screen.findByText("hello")

    expect(store.getCellView("cell-1")?.aiDrafted).toBe(true)
  })

  it("renders the same header for a human-typed draft (no regression)", async () => {
    renderTable(makeStore(false))
    await screen.findByText("hello")

    expect(screen.queryByText(message("editor.ai.draftBadge"))).toBeNull()
    expect(document.body.textContent).not.toMatch(/review required/i)
  })
})
