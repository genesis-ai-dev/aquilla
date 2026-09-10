/**
 * The source and target columns' first text lines must sit on the same baseline.
 *
 * That alignment is not produced by a shared grid row — each column stacks its
 * own header strip above its text, and they line up only because both strips
 * reserve the same 20px (h-4 + mb-1):
 *
 *   source column:  py-1.5 (6px) + context line (20px)          -> text at 26px
 *   target column:  header lane (20px) + surface py-1.5 (6px)   -> text at 26px
 *
 * So the context line must render even when it has nothing to say. `cell.context`
 * is a VTT cue range (see buildCellData in useCells.ts) and is therefore EMPTY for
 * every ordinary text cell — gating the line on truthy content drops it for the
 * common case and rides all that source text 20px above its translation. The
 * target lane can't be gated to match, because it also reserves the strip the
 * floating action rail occupies.
 *
 * happy-dom has no layout engine, so this asserts the structural invariant that
 * produces the alignment rather than measured geometry.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
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

/**
 * No startMs/endMs, so buildCellData derives an empty `context` — the common case.
 * Pass `timecode: true` to attach cue timings so `context` becomes a VTT range
 * (the timeline-ordered / subtitle case).
 */
function makeRows(id: string, { timecode = false }: { timecode?: boolean } = {}): CellRow[] {
  const timing = timecode ? { startMs: 0, endMs: 3970 } : {}
  return [
    {
      cellId: id, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
      ...timing,
    },
    {
      cellId: id, side: "target", value: "bonjour", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
      ...timing,
    },
  ]
}

/** AQU-646: the corner label reads the ASSIGNED VOICE's name, through the
 *  project's cast assignments — not the character sheet's `cast_name`, which is
 *  a separate store. Sam's call was that the two cell corners agree with each
 *  other. */
const projectWithCast: ProjectRecord = {
  ...project,
  ttsSettings: {
    castAssignments: { "cell-1": "voice-ravi" },
    voices: [{ id: "voice-ravi", name: "Ravi" }],
  },
} as unknown as ProjectRecord

function renderTable({ lineNumbers = false, timecode = false, cellLabels = false }: { lineNumbers?: boolean; timecode?: boolean; cellLabels?: boolean } = {}) {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows("cell-1", { timecode }), { full: true, maxServerSeq: 1 })
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          // ALWAYS the cast-bearing project, so `cellLabelsEnabled` below is
          // the ONLY variable (2026-08-28). This used to swing with the gate
          // flag, which meant the gate-off test rendered a project with no
          // `ttsSettings` at all — so the label was absent because there was no
          // cast to show, not because the gate withheld it. Delete the gate
          // entirely and that test still passed.
          project={projectWithCast}
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
          lineNumbersEnabled={lineNumbers}
          cellLabelsEnabled={cellLabels}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — source/target first-line alignment", () => {
  it("reserves the source context line even when the cell has no context", async () => {
    renderTable()
    await screen.findByText("hello")

    const contextLine = screen.getByTestId("source-context-line")
    // Present, and empty — this is the case that regresses if it gets gated.
    expect(contextLine.textContent).toBe("")
    expect(contextLine.className).toContain("h-4")
    expect(contextLine.className).toContain("mb-1")
  })

  it("mirrors that strip with the target header lane, so both reserve the same height", async () => {
    renderTable()
    await screen.findByText("hello")

    const contextLine = screen.getByTestId("source-context-line")
    const headerLane = screen.getByTestId("target-header-lane")

    // The mirror IS the alignment: same reserved height on both sides.
    for (const cls of ["h-4", "mb-1"]) {
      expect(contextLine.className).toContain(cls)
      expect(headerLane.className).toContain(cls)
    }
  })

  it("reserves the same strip in the gutter, so the line number rides the first source line", async () => {
    renderTable()
    await screen.findByText("hello")

    // Third mirror. The gutter is a separate grid column, so it needs its own
    // copy of the strip or the number floats above the text it labels.
    const spacer = screen.getByTestId("gutter-strip-spacer")
    expect(spacer.className).toContain("h-4")
    expect(spacer.className).toContain("mb-1")

    // Combined select/badges/number gutter owns the vertical padding; the
    // spacer sits inside the number slot (select | badges+number group).
    const gutter = spacer.parentElement?.parentElement?.parentElement
    expect(gutter?.className).toContain("py-1.5")
  })

  // AQU-800: the timecode range on timeline-ordered (subtitle/media) cells must
  // read flush-left above the source text, while other context (empty, scripture
  // verse refs) stays centered. Detection reuses parseTimestampRange, so only a
  // real cue range flips the alignment — no false positive from a verse ref.
  // AQU-646 stage 6G (2026-08-27, the client's ask via Sam): the timecode moved
  // OUT of the top lane and down to the foot of the cell, so the character
  // label has the corner to itself. It keeps its flush-left reading and its own
  // `data-context-kind`; what changed is which line it lives on.
  it("reads the timecode flush-left at the FOOT of the cell", async () => {
    renderTable({ timecode: true })
    await screen.findByText("hello")

    const timingLine = screen.getByTestId("source-timing-line")
    expect(timingLine.textContent).toBe("00:00:00.000 --> 00:00:03.970")
    expect(timingLine.getAttribute("data-context-kind")).toBe("timecode")
    expect(timingLine.className).toContain("justify-start")
    expect(timingLine.className).toContain("text-left")
    expect(timingLine.className).not.toContain("justify-center")

    // …and the lane at the top no longer carries it at all.
    const contextLine = screen.getByTestId("source-context-line")
    expect(contextLine.textContent).toBe("")
    expect(contextLine.getAttribute("data-context-kind")).toBeNull()
    // The 20px strip is still reserved — it is what holds the source and target
    // columns' first lines on one baseline, whether or not it has anything in
    // it. That is exactly why the timing could move and the lane could not.
    expect(contextLine.className).toContain("h-4")
    expect(contextLine.className).toContain("mb-1")
  })

  // The foot line is NOT reserved when empty, and that asymmetry is deliberate:
  // nothing below the source text mirrors anything in the target column, so an
  // always-on strip would be wasted height on every scripture row in the app.
  it("draws no foot line at all when the context is not a timecode", async () => {
    renderTable()
    await screen.findByText("hello")
    expect(screen.queryByTestId("source-timing-line")).toBeNull()
  })

  it("keeps non-timecode context (empty / verse ref) centered", async () => {
    renderTable()
    await screen.findByText("hello")

    const contextLine = screen.getByTestId("source-context-line")
    expect(contextLine.getAttribute("data-context-kind")).toBeNull()
    expect(contextLine.className).toContain("justify-center")
    expect(contextLine.className).toContain("text-center")
    expect(contextLine.className).not.toContain("justify-start")
  })

  it("sizes the line-number box to the source line height, not a fixed height", async () => {
    renderTable({ lineNumbers: true })
    await screen.findByText("hello")

    // Centering the digit in a fontSize x 1.6 box is what keeps it on the first
    // line at every reader font size; a fixed height only agrees at one size.
    const numberBox = screen.getByLabelText("Line 1")
    expect(numberBox.style.height).toBe("calc(14px * 1.6)")
    expect(numberBox.className).not.toContain("h-6")
  })
})

// ── AQU-646 ─────────────────────────────────────────────────────────────────
//
// Sam, 2026-08-26: "you know how in the top left corner of target cells there's
// the character name… let's put that character label also in the top left of
// source cells where currently there's the time range — we'll just scoot the
// time range over."
describe("EditorTable — the character label on source cells", () => {
  it("gives the label the top-left corner, with the timing below", async () => {
    renderTable({ timecode: true, cellLabels: true })
    await screen.findByText("hello")
    const line = screen.getByTestId("source-context-line")
    const label = screen.getByTestId("source-cell-label")
    expect(label).toHaveTextContent("Ravi")
    // The corner is the label's alone now — stage 6G moved the timing out.
    expect(line.textContent).toBe("Ravi")
    expect(line.firstElementChild).toBe(label)
    // …and it went to the foot, not away.
    expect(screen.getByTestId("source-timing-line").textContent)
      .toBe("00:00:00.000 --> 00:00:03.970")
  })

  // The two lines are the cell's first and last, which is the whole of what
  // "top-left" and "bottom-left" mean here.
  it("puts the label above the source text and the timing below it", async () => {
    renderTable({ timecode: true, cellLabels: true })
    await screen.findByText("hello")
    const line = screen.getByTestId("source-context-line")
    const timing = screen.getByTestId("source-timing-line")
    const cellEl = line.parentElement!
    // Both lines belong to the SAME cell, and the timing is its last element —
    // the floating edit pencil sits before the lane, so "first child" is not
    // the thing to assert; "last child" is exactly the bottom of the cell.
    expect(timing.parentElement).toBe(cellEl)
    expect(cellEl.lastElementChild).toBe(timing)
    expect(timing.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    // The source text itself sits between them.
    expect(line.compareDocumentPosition(screen.getByText("hello")) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  // The 20px lane is what holds source and target text on one baseline, and a
  // name added to it must not change that.
  it("does not grow the lane that keeps the two columns aligned", async () => {
    renderTable({ timecode: true, cellLabels: true })
    await screen.findByText("hello")
    const line = screen.getByTestId("source-context-line")
    for (const cls of ["h-4", "mb-1"]) expect(line.className).toContain(cls)
    // A long name truncates rather than pushing anything out of the row.
    expect(screen.getByTestId("source-cell-label").className).toContain("truncate")
  })

  // Centring is for a bare verse reference. Once the corner holds a name, the
  // lane reads left-to-right like the label it now is.
  it("left-aligns the lane for a labelled cell even with no timecode", async () => {
    renderTable({ timecode: false, cellLabels: true })
    await screen.findByText("hello")
    const line = screen.getByTestId("source-context-line")
    expect(line.className).toContain("justify-start")
    expect(line.className).not.toContain("justify-center")
  })

  it("is absent when cell labels are switched off", async () => {
    renderTable({ timecode: true })
    await screen.findByText("hello")
    expect(screen.queryByTestId("source-cell-label")).toBeNull()
  })
})
