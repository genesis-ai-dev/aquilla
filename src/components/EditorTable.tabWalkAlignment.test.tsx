/**
 * AQU-1534: a keyboard walk must leave every translation beside its own source.
 *
 * Activating a target cell is asynchronous — the read surface is swapped for a
 * freshly mounted `TranslatedEditor` that takes the caret a frame or two later.
 * AQU-746 and AQU-1333 cover that window for the POINTER path: `requestTargetEdit`
 * parks focus on the row wrapper, makes it an editing host, and buffers whatever
 * arrives (keystrokes, `Input.insertText`, IME commits, paste) for replay.
 *
 * Keyboard navigation took a different route. Tab / Shift+Tab / ↑ / ↓ activate the
 * neighbour through the table's `onActivateEditor`, never through this row's
 * `requestTargetEdit`, so no window opened on the destination: the previous
 * editor unmounted in the same commit, focus fell to `<body>`, and everything
 * typed before the next editor mounted went on the floor. The row a translator
 * tabbed into stayed empty while they kept typing, so their text came to rest
 * beside the wrong source — and a wrong pairing can then be validated.
 *
 * These tests walk five rows the way the ticket describes and hold both halves:
 * the destination row is an editing host for the gap, and what lands in it ends
 * up in that row's own document — never a neighbour's.
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
// visible. Render every row instead — this suite walks between rows.
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
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

/** Five rows, every target empty — the file the qa-bot walked. */
const SOURCES = [
  "Come before God daily.",
  "He is near to the broken.",
  "Mercies are new every dawn.",
  "Give thanks in the morning.",
  "Rest in the shadow of his wing.",
]
/** What the translator types, one per row. */
const TARGETS = ["uno", "dos", "tres", "cuatro", "cinco"]

const cellIdAt = (index: number) => `cell-${index + 1}`

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  const rows: CellRow[] = []
  SOURCES.forEach((value, index) => {
    const cellId = cellIdAt(index)
    rows.push({
      cellId,
      side: "source",
      value,
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${index + 1}`,
      anchorCellId: null,
      eventId: `${cellId}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 4,
    })
    rows.push({
      cellId,
      side: "target",
      value: "",
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${index + 1}`,
      anchorCellId: null,
      eventId: `${cellId}-target`,
      sourceEventId: `${cellId}-source`,
      lastEditor: null,
      lastEditAt: 2,
      validated: false,
      wordCount: 0,
    })
  })
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

function rowFor(index: number): HTMLElement {
  const row = document.querySelector(
    `[data-cell-id="${cellIdAt(index)}"] [data-grid-row]`,
  )
  if (!row) throw new Error(`no row rendered for ${cellIdAt(index)}`)
  return row as HTMLElement
}

/** How a browser agent, dictation, IME or paste delivers text: no keydown. */
function insertText(host: HTMLElement, data: string): InputEvent {
  const event = new InputEvent("beforeinput", {
    inputType: "insertText",
    data,
    bubbles: true,
    cancelable: true,
  })
  host.dispatchEvent(event)
  return event
}

/** Wait for a row's editor to mount, then let it take the caret. */
async function settleEditor(index: number): Promise<EditorSurface> {
  const row = rowFor(index)
  const surface = await waitFor(() => {
    const pm = row.querySelector(".ProseMirror") as EditorSurface | null
    if (!pm?.editor) throw new Error(`editor not mounted for row ${index}`)
    return pm
  })
  act(() => { fireEvent.focus(surface) })
  return surface
}

/** The text a row shows when it is NOT the active editor. */
function readViewText(index: number): string {
  const read = rowFor(index).querySelector("[data-target-read-view]")
  return (read?.textContent ?? "").trim()
}

afterEach(cleanup)

describe("EditorTable — Tab walk keeps each translation on its own row (AQU-1534)", () => {
  it("makes the row Tab lands on an editing host while its editor mounts", async () => {
    renderTable()
    await screen.findByText(SOURCES[0])

    fireEvent.click(rowFor(0).querySelector("[data-target-read-view]") as HTMLElement)
    const first = await settleEditor(0)
    act(() => { first.editor!.commands.insertContent(TARGETS[0]) })

    act(() => { fireEvent.keyDown(first, { key: "Tab" }) })

    // Load-bearing half of the fix. Without it focus sits on <body> here, the
    // row is a plain div, and text arriving before the editor mounts has
    // nothing to fire on — it is lost with no event to catch.
    const second = rowFor(1)
    expect(second.isContentEditable).toBe(true)
    expect(document.activeElement).toBe(second)
  })

  it("leaves each of five typed translations beside its own source row", async () => {
    renderTable()
    await screen.findByText(SOURCES[0])

    // Row 1 is entered by pointer, as a translator starts a file.
    fireEvent.click(rowFor(0).querySelector("[data-target-read-view]") as HTMLElement)
    let surface = await settleEditor(0)
    act(() => { surface.editor!.commands.insertContent(TARGETS[0]) })
    expect(surface.editor!.getText()).toBe(TARGETS[0])

    // Rows 2–5 are reached by Tab, and typed into straight away — before the
    // destination editor has mounted. That gap is where the text used to go.
    for (let index = 1; index < SOURCES.length; index += 1) {
      act(() => { fireEvent.keyDown(surface, { key: "Tab" }) })
      const event = insertText(document.activeElement as HTMLElement, TARGETS[index])
      // Cancelled, so nothing is spliced into React-owned row markup.
      expect(event.defaultPrevented).toBe(true)
      surface = await settleEditor(index)
      expect(surface.editor!.getText()).toBe(TARGETS[index])
    }

    // Nothing shifted: every row holds what was typed for it, and row 1 — the
    // row the bot found empty — still holds row 1's text.
    for (let index = 0; index < SOURCES.length - 1; index += 1) {
      expect(readViewText(index)).toBe(TARGETS[index])
    }
    expect(readViewText(0)).not.toBe("")
  })

  it("keeps an edit on the row Shift+Tab went back to", async () => {
    renderTable()
    await screen.findByText(SOURCES[0])

    // Fill rows 1 and 2, leaving the caret in row 2.
    fireEvent.click(rowFor(0).querySelector("[data-target-read-view]") as HTMLElement)
    let surface = await settleEditor(0)
    act(() => { surface.editor!.commands.insertContent(TARGETS[0]) })
    act(() => { fireEvent.keyDown(surface, { key: "Tab" }) })
    insertText(document.activeElement as HTMLElement, TARGETS[1])
    surface = await settleEditor(1)
    expect(surface.editor!.getText()).toBe(TARGETS[1])

    // Step back and keep typing in the gap, as a translator correcting a row does.
    act(() => { fireEvent.keyDown(surface, { key: "Tab", shiftKey: true }) })
    insertText(document.activeElement as HTMLElement, " corregido")
    const back = await settleEditor(0)

    expect(back.editor!.getText()).toBe(`${TARGETS[0]} corregido`)
    expect(readViewText(1)).toBe(TARGETS[1])
  })
})
