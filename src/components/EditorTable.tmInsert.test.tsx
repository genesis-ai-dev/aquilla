/**
 * AQU-1393: the Examples panel's exact-match Insert must leave the cell
 * UNVALIDATED.
 *
 * Insert goes through the editor's ordinary commit path, and that path
 * validates a human edit on commit ("a human has touched it"). So the first
 * cut of Insert marked the cell self-validated with text the translator had
 * only clicked, never reviewed — one click per row was enough to turn a file
 * green. The editor-level tests could not see it: they stop at `onCommit`, and
 * the validation is decided one layer up, in the row.
 *
 * These render the real EditorTable + ExamplePanel + TranslatedEditor and pin
 * what reaches the outbox: the commit, and no `cell.validate` beside it.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, Fragment, forwardRef, useImperativeHandle, type ReactNode } from "react"
import type { Editor } from "@tiptap/core"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ScoredPair } from "@/lib/search/dual-index"
import { ROLE } from "@/lib/frontier/roles"
import { emitCellValidate, emitTargetCellCommit } from "@/lib/sync/events-emit"

vi.mock("@/lib/sync/events-emit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/events-emit")>()
  return {
    ...actual,
    emitTargetCellCommit: vi.fn(async () => "E-commit"),
    emitCellValidate: vi.fn(async () => "E-validate"),
  }
})

// happy-dom has no layout engine, so LegendList may render no rows. Replace it
// with a trivial "render every row" stand-in (same as the other EditorTable
// RTL suites).
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
  vi.mocked(emitCellValidate).mockClear()
})

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  // project_lead (500): may edit AND validate, with self-validation allowed by
  // default — the role for which a typed edit auto-validates.
  syncRole: { level: ROLE.PROJECT_LEAD, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
}

const SOURCE = "In the beginning God created"
const TM_TARGET = "Au commencement Dieu créa"

function rows(): CellRow[] {
  return [
    {
      cellId: "cell-1", side: "source", value: SOURCE, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 5,
    },
    {
      cellId: "cell-1", side: "target", value: "", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-target",
      sourceEventId: "cell-1-source", lastEditor: null, lastEditAt: 2, validated: false,
      wordCount: 0,
    },
  ]
}

// One pair whose source is identical to the cell's (the 100% match that offers
// Insert) and one unrelated pair.
const examples: ScoredPair[] = [
  {
    cellId: "tm-1", fileId: "file-tmx", source: SOURCE, target: TM_TARGET,
    score: 1, matchedTokens: ["beginning", "god", "created"], coverageWeight: 1,
  },
  {
    cellId: "tm-2", fileId: "file-tmx", source: "The earth was without form", target: "La terre était informe",
    score: 1, matchedTokens: [], coverageWeight: 0.1,
  },
]

function renderTable(onValidated: (cellId: string) => void) {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(rows(), { full: true, maxServerSeq: 1 })
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(EditorActionsProvider, {
        value: {},
        children: createElement(EditorTable, {
          project,
          cellStore: store,
          username: "tester",
          isCompletionConfigured: false,
          isCompletionAvailable: false,
          completing: new Map(),
          examples: new Map([["cell-1", examples]]),
          errors: new Map(),
          previews: new Map(),
          onCompleteSingle: () => {},
          onCompleteBatch: () => {},
          healthMap: new Map(),
          lineNumbersEnabled: false,
          cellLabelsEnabled: true,
          sourceTextDirection: "ltr",
          targetTextDirection: "ltr",
          onValidated,
        }),
      }),
    ),
  )
}

type MountedEditor = HTMLElement & { editor?: Editor }

/** Open the row's Examples popover and click Insert on the exact match. */
async function clickInsert() {
  fireEvent.click(await screen.findByRole("button", { name: /2 examples/i }))
  fireEvent.click(await screen.findByTestId("example-insert"))
}

/** The editor Insert opened, focused — focus is what drains the queued text. */
async function focusedEditor(): Promise<MountedEditor> {
  const pm = await waitFor(() => {
    const el = document.querySelector(".ProseMirror") as MountedEditor | null
    if (!el?.editor) throw new Error("editor not mounted yet")
    return el
  })
  act(() => {
    fireEvent.focus(pm)
  })
  return pm
}

/** Let the row's continuation on the commit run — where a validate would be emitted. */
async function commitSettled(nth: number) {
  await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(nth))
  await act(async () => {
    await vi.mocked(emitTargetCellCommit).mock.results[nth - 1].value
  })
}

describe("EditorTable — AQU-1393 exact-match Insert lands unvalidated", () => {
  it("commits the match's translation without validating the cell, from a read-view row", async () => {
    const onValidated = vi.fn()
    renderTable(onValidated)

    await clickInsert()
    const pm = await focusedEditor()

    await commitSettled(1)
    expect(vi.mocked(emitTargetCellCommit).mock.calls[0][0]).toMatchObject({ cellId: "cell-1", value: TM_TARGET })
    expect(pm.editor!.getText()).toBe(TM_TARGET)
    expect(emitCellValidate).not.toHaveBeenCalled()

    // Leaving the cell with the inserted text untouched must not validate it
    // either, nor hand it to the repetition fill as a settled validation.
    act(() => {
      fireEvent.blur(pm)
    })
    await waitFor(() => expect(document.querySelector('[data-editor-cell-surface="target-read"]')).not.toBeNull())
    expect(emitTargetCellCommit).toHaveBeenCalledTimes(1)
    expect(emitCellValidate).not.toHaveBeenCalled()
    expect(onValidated).not.toHaveBeenCalled()
  })

  it("validates as usual once the translator edits the inserted text", async () => {
    const onValidated = vi.fn()
    renderTable(onValidated)

    await clickInsert()
    const pm = await focusedEditor()
    await commitSettled(1)
    expect(emitCellValidate).not.toHaveBeenCalled()

    // The translator reworks it: this commit is their own wording again, so the
    // ordinary rule applies. The exemption covers the Insert commit only.
    act(() => {
      pm.editor!.commands.setContent(`${TM_TARGET} tout`)
    })
    act(() => {
      fireEvent.blur(pm)
    })

    await commitSettled(2)
    expect(vi.mocked(emitTargetCellCommit).mock.calls[1][0]).toMatchObject({ value: `${TM_TARGET} tout` })
    await waitFor(() => expect(emitCellValidate).toHaveBeenCalledTimes(1))
    expect(vi.mocked(emitCellValidate).mock.calls[0][0]).toMatchObject({ cellId: "cell-1", editEventId: "E-commit" })
  })
})
