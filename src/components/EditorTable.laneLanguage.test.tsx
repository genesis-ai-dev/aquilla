/**
 * AQU-1908: the target editor's `lang` — what the browser's spell-checker
 * reads to pick a dictionary, and what smart quotes read for their style —
 * is the ACTIVE LANE's language CODE.
 *
 * Two things were wrong with the value it carried before. It was the freeform
 * label the user typed ("Spanish", "Grade 7 English"), which is a name and not
 * a language tag, so no dictionary resolved from it at all; and it was read off
 * the project record's `targetLanguage`, which names one language per project.
 * A Spanish lane and a French lane must be checked against their own
 * dictionaries, and a lane whose label matches no catalog entry must carry no
 * attribute rather than a bogus one.
 *
 * Asserted on the rendered row, which is the level the bug escaped at: the
 * helper resolves a code correctly in isolation (lane-language.test.ts), but
 * nothing wired it to the lane the editor is pointed at.
 */

import { afterEach, describe, it, expect, vi } from "vitest"
import { render, fireEvent, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { ROLE } from "@/lib/frontier/roles"
import { resetContextualDraftsStore } from "@/lib/contextual/drafts-store"

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))
vi.mock("@/lib/contextual/transport", () => ({ reviewContextualDraft: vi.fn(() => Promise.resolve()) }))
vi.mock("@/lib/cell-telemetry", () => ({ captureCellValidation: vi.fn(), captureAudioAction: vi.fn() }))

// happy-dom has no layout engine — render every row (same shim as
// EditorTable.lane.test).
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

const SPANISH_LANE = ""
const FRENCH_LANE = "bbbb0002"
const REGISTER_LANE = "cccc0003"
const CODE_OVERRIDE_LANE = "dddd0004"

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "English",
  // The project-level label. Deliberately NOT the French lane's language: the
  // attribute must follow the lane, not this.
  targetLanguage: "Spanish",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  lanes: [
    { id: "aaaa0000", role: "source", language: "English", name: null, langCode: null, legacyTag: null, position: 0, archivedAt: null },
    { id: "aaaa0001", role: "target", language: "Spanish", name: null, langCode: null, legacyTag: SPANISH_LANE, position: 1, archivedAt: null },
    { id: FRENCH_LANE, role: "target", language: "French", name: null, langCode: null, legacyTag: FRENCH_LANE, position: 2, archivedAt: null },
    { id: REGISTER_LANE, role: "target", language: "Grade 7 English", name: null, langCode: null, legacyTag: REGISTER_LANE, position: 3, archivedAt: null },
    { id: CODE_OVERRIDE_LANE, role: "target", language: "Tshangla", name: null, langCode: "tsj", legacyTag: CODE_OVERRIDE_LANE, position: 4, archivedAt: null },
  ],
  syncRole: { level: ROLE.PROJECT_LEAD, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
}

function makeRows(id: string): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: id, side: "target", value: "bonjour", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
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
  store.replaceRows(makeRows("cell-1"), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(activeLane: string) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ myScopes: [] }}>
        <EditorTable
          project={project}
          cellStore={makeStore()}
          username="tester"
          activeLane={activeLane}
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

/** The target side as the row renders it before anyone clicks into it. */
function targetReadView(): HTMLElement {
  const surface = document.querySelector("[data-target-read-view]")
  expect(surface).toBeTruthy()
  return surface as HTMLElement
}

afterEach(() => {
  resetContextualDraftsStore()
})

describe("EditorTable — the target editor's lang follows the active lane (AQU-1908)", () => {
  it("is the default lane's language code, not its freeform label", () => {
    renderTable(SPANISH_LANE)
    expect(targetReadView().getAttribute("lang")).toBe("es")
  })

  it("switches dictionary with the lane — a French lane in a Spanish-first project", () => {
    renderTable(FRENCH_LANE)
    expect(targetReadView().getAttribute("lang")).toBe("fr")
  })

  it("carries no lang for a lane whose label no catalog entry matches", () => {
    renderTable(REGISTER_LANE)
    expect(targetReadView().hasAttribute("lang")).toBe(false)
  })

  it("prefers the lane's code override over the code derived from its label", () => {
    renderTable(CODE_OVERRIDE_LANE)
    expect(targetReadView().getAttribute("lang")).toBe("tsj")
  })

  it("gives the open editor the same lang as the read surface it replaced", async () => {
    renderTable(FRENCH_LANE)
    expect(targetReadView().getAttribute("lang")).toBe("fr")

    act(() => {
      fireEvent.click(targetReadView())
    })

    const editor = await vi.waitFor(() => {
      const surface = document.querySelector(".ProseMirror")
      expect(surface).toBeTruthy()
      return surface as HTMLElement
    })
    expect(editor.getAttribute("lang")).toBe("fr")
  })
})
