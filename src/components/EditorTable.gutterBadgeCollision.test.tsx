/**
 * AQU-831: the per-row status badges must not collide.
 *
 * Reported (2026-08-08, AQU-646 media-lens QA): with more than one badge state
 * live, the failed-audio badge rendered UNDER the stale-source warning (one hid
 * the other entirely), and it covered the row number and the selection tick box.
 *
 * happy-dom has no layout engine, so this pins the structural invariants that
 * decide the collision rather than measuring pixels:
 *   1. every live badge is rendered (none is hidden behind a sibling),
 *   2. every badge lives inside the reserved gutter strip — so it cannot paint
 *      over the tick box or the number pill, which are its SIBLINGS,
 *   3. the strip stacks them in flow (flex column), and no badge is taken out
 *      of flow with absolute/fixed positioning, which is what made them pile up,
 *   4. each badge occupies the same square slot, so a stack stays aligned in
 *      the fixed-width column.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { setTtsStatus, ttsStatusKey } from "@/lib/audio/tts"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/lib/health/kill-switch", () => ({ useHealthCalculationsEnabled: () => true }))

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

const CELL = "cell-1"

afterEach(cleanup)
beforeEach(() => {
  setTtsStatus(ttsStatusKey(CELL), { kind: "idle" })
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

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  const rows: CellRow[] = [
    {
      cellId: CELL, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${CELL}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: CELL, side: "target", value: "bonjour", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${CELL}-target`,
      sourceEventId: `${CELL}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

/** Render one row with EVERY badge state live at once. */
function renderAllBadgesRow() {
  const qc = new QueryClient()
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ onOpenComments: () => {} }}>
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
          staleCellIds={new Set([CELL])}
          cellOpenCommentCount={new Map([[CELL, 2]])}
        />
      </EditorActionsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe("EditorTable — AQU-831 row status badges do not collide", () => {
  it("renders the stale-source AND failed-audio AND comments badges together", async () => {
    setTtsStatus(ttsStatusKey(CELL), { kind: "error", message: "no gemini api key" })
    renderAllBadgesRow()
    await screen.findByText("hello")

    // 1. All three are present — neither hides the other.
    expect(screen.getByTestId("stale-source-indicator")).not.toBeNull()
    expect(screen.getByTestId("synth-status-error")).not.toBeNull()
    expect(screen.getByLabelText(/comment/i)).not.toBeNull()
  })

  it("keeps every badge inside the reserved gutter strip, never over the row chrome", async () => {
    setTtsStatus(ttsStatusKey(CELL), { kind: "error", message: "no gemini api key" })
    renderAllBadgesRow()
    await screen.findByText("hello")

    const strip = screen.getByTestId("gutter-status-badges")
    // 2. Containment: the badges are DESCENDANTS of the strip, so they occupy
    //    the strip's reserved width and cannot paint over the tick box / number.
    expect(strip.contains(screen.getByTestId("stale-source-indicator"))).toBe(true)
    expect(strip.contains(screen.getByTestId("synth-status-error"))).toBe(true)

    // The selection tick box and the number pill are OUTSIDE the strip.
    const tickBox = screen.getByRole("checkbox", { name: /select/i })
    expect(strip.contains(tickBox)).toBe(false)

    // 3. The strip reserves a fixed width and stacks in flow.
    expect(strip.className).toContain("w-5")
    expect(strip.className).toContain("shrink-0")
    const stack = strip.querySelector(".flex-col.gap-0\\.5") ?? strip
    expect(stack.className).toContain("flex-col")
  })

  it("takes no badge out of flow (absolute positioning is what made them pile up)", async () => {
    setTtsStatus(ttsStatusKey(CELL), { kind: "error", message: "no gemini api key" })
    renderAllBadgesRow()
    await screen.findByText("hello")

    const strip = screen.getByTestId("gutter-status-badges")
    for (const el of Array.from(strip.querySelectorAll("*"))) {
      const cls = (el as HTMLElement).className
      if (typeof cls !== "string") continue
      expect(cls).not.toMatch(/(^|\s)absolute(\s|$)/)
      expect(cls).not.toMatch(/(^|\s)fixed(\s|$)/)
    }
  })

  it("gives each stacked badge the same square slot so the column stays aligned", async () => {
    setTtsStatus(ttsStatusKey(CELL), { kind: "error", message: "no gemini api key" })
    renderAllBadgesRow()
    await screen.findByText("hello")

    const stale = screen.getByTestId("stale-source-indicator")
    const synth = screen.getByTestId("synth-status-error")
    const comments = screen.getByLabelText(/comment/i)

    // Each badge is its own h-5 w-5 slot. Before the fix the stale triangle was
    // a bare h-3 inline span, so it sat off-centre against the h-5 neighbours.
    for (const badge of [stale, synth, comments]) {
      expect(badge.className).toContain("h-5")
      expect(badge.className).toContain("w-5")
    }
  })
})
