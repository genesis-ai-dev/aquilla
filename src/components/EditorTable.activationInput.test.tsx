/**
 * AQU-1333: text that arrives during the target-cell activation window without
 * a keydown must survive.
 *
 * Activation is asynchronous — the read surface is swapped for a freshly
 * mounted `TranslatedEditor` that only takes focus a frame or two later. The
 * row wrapper holds focus in the gap. AQU-746 buffers `keydown` there, so a
 * fast typist is safe; everything else was not:
 *
 *   - CDP `Input.insertText` — how browser agents and Playwright's
 *     `fill`/`insertText` type. This is how the bug was caught: a Jev run
 *     replaced GEN 1:5, saw its own text on screen, reported DONE — and the
 *     seeded text was still there after a reload. Nothing reached the outbox.
 *   - IME composition, OS dictation, paste.
 *
 * None of those produce a keydown, and none of them fire at all on an element
 * that is not an editing host — which the plain `<div tabindex=0>` row wrapper
 * was not. These tests hold both halves: the row becomes an editing host for
 * the window, and what lands in it reaches the editor's document.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Editor } from "@tiptap/core"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// happy-dom has no layout engine, so the real LegendList may decide no rows are
// visible. Render every row instead — this suite is about one cell's input path.
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
        data.map((item, index) => React.createElement(
          React.Fragment,
          { key: keyExtractor?.(item, index) ?? item },
          renderItem({ item, index }),
        )),
      )
    }),
  }
})

type EditorSurface = HTMLElement & { editor?: Editor }

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  const rows: CellRow[] = [
    {
      cellId: "cell-1",
      side: "source",
      value: "hello",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: "cell-1-source",
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
    },
    {
      cellId: "cell-1",
      side: "target",
      value: "bonjour",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: "cell-1-target",
      sourceEventId: "cell-1-source",
      lastEditor: "tester",
      lastEditAt: 2,
      validated: false,
      wordCount: 1,
    },
  ]
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function renderTable() {
  const qc = new QueryClient()
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
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
          />
        </EditorActionsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

/** Click into the target cell, as a translator (or an agent) does. */
async function activateTargetCell(): Promise<HTMLElement> {
  const target = await screen.findByText("bonjour")
  const row = target.closest("[data-grid-row]") as HTMLElement
  const readSurface = row.querySelector("[data-target-read-view]") as HTMLElement
  fireEvent.click(readSurface)
  return row
}

function insertText(row: HTMLElement, data: string): InputEvent {
  const event = new InputEvent("beforeinput", {
    inputType: "insertText",
    data,
    bubbles: true,
    cancelable: true,
  })
  row.dispatchEvent(event)
  return event
}

afterEach(cleanup)

describe("EditorTable — activation window captures non-keydown input (AQU-1333)", () => {
  it("makes the row an editing host while the editor mounts", async () => {
    renderTable()
    const row = await activateTargetCell()

    // Without this the row is a plain div: `Input.insertText`, composition and
    // dictation have nothing to fire on, so the text is lost with no event to
    // catch. This attribute IS the fix's load-bearing half.
    expect(row.isContentEditable).toBe(true)
  })

  it("lands agent-inserted text in the editor document, not on the floor", async () => {
    renderTable()
    const row = await activateTargetCell()

    const event = insertText(row, "au commencement")
    // Cancelled, so nothing is spliced into React-owned row DOM.
    expect(event.defaultPrevented).toBe(true)

    const surface = await waitFor(() => {
      const pm = row.querySelector(".ProseMirror") as EditorSurface | null
      if (!pm?.editor) throw new Error("editor not mounted yet")
      return pm
    })
    act(() => { fireEvent.focus(surface) })

    // The text the agent "typed" is now real editor content, so the ordinary
    // debounce → commit → outbox path carries it — which is what failed before:
    // the text was visible on screen and never persisted.
    expect(surface.editor!.getText()).toBe("bonjourau commencement")
  })

  it("stops being an editing host once the editor owns the caret", async () => {
    renderTable()
    const row = await activateTargetCell()

    const surface = await waitFor(() => {
      const pm = row.querySelector(".ProseMirror") as EditorSurface | null
      if (!pm?.editor) throw new Error("editor not mounted yet")
      return pm
    })
    act(() => { fireEvent.focus(surface) })

    // Two live editing hosts in one row would double-apply every keystroke and
    // read to a screen reader as two text fields.
    await waitFor(() => expect(row.isContentEditable).toBe(false))
  })

  it("keeps a paste that lands before the editor is ready", async () => {
    renderTable()
    const row = await activateTargetCell()

    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? " collé" : "") },
    })
    row.dispatchEvent(paste)
    // Cancelled, so the clipboard text cannot be dropped into row markup.
    expect(paste.defaultPrevented).toBe(true)

    const surface = await waitFor(() => {
      const pm = row.querySelector(".ProseMirror") as EditorSurface | null
      if (!pm?.editor) throw new Error("editor not mounted yet")
      return pm
    })
    act(() => { fireEvent.focus(surface) })

    expect(surface.editor!.getText()).toBe("bonjour collé")
  })
})
