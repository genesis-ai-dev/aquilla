/**
 * AQU-1484: a typed edit is validated by the commit path itself, and that
 * automatic validation never reached `onValidated` — the hook the workspace
 * uses to fill a file's repeated segments (AQU-1391). Only a click on the
 * gutter check did, and a self-validated row's check no longer validates
 * anything, so a translator who simply typed a translation got a green check
 * and empty repetitions.
 *
 * These render the real EditorTable + TranslatedEditor and pin WHEN the row
 * hands its cell to `onValidated`: once the edit is settled (the editor is
 * left), never from an idle save while the caret is still in the cell.
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

const baseProject: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  // project_lead (500): may edit and validate.
  syncRole: { level: ROLE.PROJECT_LEAD, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
}

function makeRows(targetValue: string): CellRow[] {
  return [
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: "cell-1", side: "target", value: targetValue, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-target",
      sourceEventId: "cell-1-source", lastEditor: "someone-else", lastEditAt: 2, validated: false,
      wordCount: 1,
    },
  ]
}

function renderTable(onValidated: (cellId: string) => void, opts: { project?: ProjectRecord; targetValue?: string } = {}) {
  const project = opts.project ?? baseProject
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(opts.targetValue ?? "old"), { full: true, maxServerSeq: 1 })
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
          onValidated,
        }),
      }),
    ),
  )
}

type MountedEditor = HTMLElement & { editor?: Editor }

/** Click the row's target into edit mode and hand back the focused editor. */
async function openEditor(): Promise<MountedEditor> {
  await screen.findByText("hello")
  const readSurface = document.querySelector('[data-editor-cell-surface="target-read"]')
  expect(readSurface).not.toBeNull()
  fireEvent.click(readSurface!)
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

/** Resolve once the row's own continuation on the auto-validate has run. */
async function autoValidateSettled() {
  await waitFor(() => expect(emitCellValidate).toHaveBeenCalledTimes(1))
  await act(async () => {
    await vi.mocked(emitCellValidate).mock.results[0].value
  })
}

describe("EditorTable — AQU-1484 a typed, auto-validated edit reaches onValidated", () => {
  it("hands the cell to onValidated when the translator types and leaves the cell", async () => {
    const onValidated = vi.fn()
    renderTable(onValidated)
    const pm = await openEditor()

    act(() => {
      pm.editor!.commands.setContent("mine")
    })
    act(() => {
      fireEvent.blur(pm)
    })

    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1))
    expect(vi.mocked(emitTargetCellCommit).mock.calls[0][0]).toMatchObject({ cellId: "cell-1", value: "mine" })
    await autoValidateSettled()
    expect(vi.mocked(emitCellValidate).mock.calls[0][0]).toMatchObject({ cellId: "cell-1", editEventId: "E-commit" })
    await waitFor(() => expect(onValidated).toHaveBeenCalledTimes(1))
    expect(onValidated).toHaveBeenCalledWith("cell-1")
  })

  it("holds back while the caret is still in the cell — an idle save must not broadcast half-typed text — then fires once on leaving", async () => {
    const onValidated = vi.fn()
    renderTable(onValidated)
    const pm = await openEditor()

    act(() => {
      pm.editor!.commands.setContent("half-typ")
    })
    // The editor's own idle window elapses with focus still in the cell: the
    // text is committed and auto-validated, exactly as before…
    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(vi.mocked(emitTargetCellCommit).mock.calls[0][0]).toMatchObject({ value: "half-typ" })
    await autoValidateSettled()
    // …but the repetitions are not touched yet.
    expect(onValidated).not.toHaveBeenCalled()

    // Leaving the cell — with nothing new to commit — settles the edit.
    act(() => {
      fireEvent.blur(pm)
    })
    await waitFor(() => expect(onValidated).toHaveBeenCalledTimes(1))
    expect(onValidated).toHaveBeenCalledWith("cell-1")
    expect(emitTargetCellCommit).toHaveBeenCalledTimes(1)
  })

  it("does not fire when the edit is not validated (self-validation disabled on the project)", async () => {
    const onValidated = vi.fn()
    renderTable(onValidated, { project: { ...baseProject, allowSelfValidation: false } })
    const pm = await openEditor()

    act(() => {
      pm.editor!.commands.setContent("mine")
    })
    act(() => {
      fireEvent.blur(pm)
    })

    await waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1))
    await act(async () => {
      await vi.mocked(emitTargetCellCommit).mock.results[0].value
    })
    expect(emitCellValidate).not.toHaveBeenCalled()
    expect(onValidated).not.toHaveBeenCalled()
  })

  it("does not fire when leaving a cell that was opened but not edited", async () => {
    const onValidated = vi.fn()
    renderTable(onValidated)
    const pm = await openEditor()

    act(() => {
      fireEvent.blur(pm)
    })

    await waitFor(() => expect(document.querySelector('[data-editor-cell-surface="target-read"]')).not.toBeNull())
    expect(emitTargetCellCommit).not.toHaveBeenCalled()
    expect(onValidated).not.toHaveBeenCalled()
  })

  it("control: the explicit validate click still reaches onValidated (AQU-1391)", async () => {
    const onValidated = vi.fn()
    renderTable(onValidated)

    fireEvent.click(await screen.findByRole("button", { name: /Click to validate/ }))

    await waitFor(() => expect(onValidated).toHaveBeenCalledTimes(1))
    expect(onValidated).toHaveBeenCalledWith("cell-1")
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
  })
})
