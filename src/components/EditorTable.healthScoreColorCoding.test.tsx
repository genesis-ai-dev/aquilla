/**
 * #946 — Health Score Color Coding on AI-draft target text.
 *
 * Display-only: the toggle paints supported vs guessed spans on an AI draft
 * that cites examples. Off, no examples, or a human-owned cell must look
 * exactly as today — no leftover data-health-span marks.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ScoredPair } from "@/lib/search/dual-index"
import {
  resetHealthScoreColorCodingCacheForTests,
  setHealthScoreColorCoding,
} from "@/lib/store/health-score-color-coding-pref"

vi.mock("@/lib/offline/store", () => ({
  isTauriRuntime: () => false,
  getOfflineStore: async () => {
    throw new Error("offline store unused in this test")
  },
}))
vi.mock("@/context/OfflineStoreContext", () => ({
  OfflineStoreProvider: ({ children }: { children: unknown }) => children,
  useOfflineStore: () => null,
}))

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

const EXAMPLE_PAIR: ScoredPair = {
  cellId: "ex-1",
  fileId: "file-1",
  source: "the Holy Spirit",
  target: "Espiritu Santo",
  score: 1,
  matchedTokens: ["espiritu", "santo"],
  coverageWeight: 1,
}

function targetRow(
  id: string,
  ref: string,
  value: string,
  extras: Partial<CellRow> = {},
): CellRow {
  return {
    cellId: id,
    side: "target",
    value,
    valueHtml: null,
    type: "text",
    canonicalRef: ref,
    anchorCellId: null,
    eventId: `${id}-target`,
    sourceEventId: `${id}-source`,
    lastEditor: "tester",
    lastEditAt: 2,
    validated: false,
    wordCount: value.trim().split(/\s+/).length,
    ...extras,
  }
}

function sourceRow(id: string, ref: string, value: string): CellRow {
  return {
    cellId: id,
    side: "source",
    value,
    valueHtml: null,
    type: "text",
    canonicalRef: ref,
    anchorCellId: null,
    eventId: `${id}-source`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 1,
    validated: false,
    wordCount: value.trim().split(/\s+/).length,
  }
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

const DEFAULT_ROWS: CellRow[] = [
  sourceRow("cell-a", "GEN 1:1", "source 0"),
  targetRow("cell-a", "GEN 1:1", "Espiritu Santo came yesterday", { aiDrafted: true }),
  sourceRow("cell-b", "GEN 1:2", "source 1"),
  targetRow("cell-b", "GEN 1:2", "target 1"),
]

function renderTable(opts?: {
  rows?: CellRow[]
  examples?: Map<string, ScoredPair[]>
  store?: CellStore
}) {
  const store = opts?.store ?? makeStore(opts?.rows ?? DEFAULT_ROWS)
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ onOpenComments: vi.fn(), cellStore: store }}>
        <EditorTable
          project={project}
          cellStore={store}
          username="tester"
          isCompletionConfigured
          isCompletionAvailable
          completing={new Map()}
          examples={opts?.examples ?? new Map([["cell-a", [EXAMPLE_PAIR]]])}
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
  return store
}

function healthSpansIn(cellId: string) {
  return document.querySelectorAll(`[data-cell-id="${cellId}"] [data-health-span]`)
}

describe("EditorTable — health score color coding (#946)", () => {
  beforeEach(() => {
    localStorage.clear()
    resetHealthScoreColorCodingCacheForTests()
    setHealthScoreColorCoding(false)
  })

  it("marks no draft until the preference is switched on", () => {
    renderTable()

    expect(healthSpansIn("cell-a")).toHaveLength(0)
    expect(healthSpansIn("cell-b")).toHaveLength(0)
  })

  it("colours supported and guessed spans on an AI draft, live, and clears on off", () => {
    renderTable()

    act(() => {
      setHealthScoreColorCoding(true)
    })

    const supported = document.querySelector(
      `[data-cell-id="cell-a"] [data-health-span="supported"]`,
    )
    const guessed = document.querySelector(
      `[data-cell-id="cell-a"] [data-health-span="guessed"]`,
    )
    expect(supported?.textContent).toBe("Espiritu Santo")
    expect(supported?.getAttribute("title")).toBe("the Holy Spirit → Espiritu Santo")
    expect(guessed?.textContent).toBe("came yesterday")
    expect(healthSpansIn("cell-b")).toHaveLength(0)

    act(() => {
      setHealthScoreColorCoding(false)
    })

    expect(healthSpansIn("cell-a")).toHaveLength(0)
  })

  it("leaves a human-owned cell unmarked even with the toggle on", () => {
    setHealthScoreColorCoding(true)
    renderTable()

    expect(healthSpansIn("cell-b")).toHaveLength(0)
  })

  it("paints an AI draft as guessed when it cites no examples", () => {
    setHealthScoreColorCoding(true)
    renderTable({ examples: new Map() })

    const guessed = document.querySelector(
      `[data-cell-id="cell-a"] [data-health-span="guessed"]`,
    )
    expect(guessed?.textContent).toBe("Espiritu Santo came yesterday")
  })

  it("resolves persisted example ids after reload", () => {
    setHealthScoreColorCoding(true)
    const rows: CellRow[] = [
      sourceRow("cell-a", "GEN 1:1", "source 0"),
      targetRow("cell-a", "GEN 1:1", "Espiritu Santo came yesterday", {
        aiDrafted: true,
        aiDraft: {
          model: "test",
          provider: "test",
          promptVersion: "v1",
          exampleIds: ["ex-1"],
          generatedAt: 1,
          mode: "single",
          projectState: {
            sourceLanguage: "en",
            targetLanguage: "fr",
            approvedExampleCount: 1,
          },
        },
      }),
      sourceRow("ex-1", "GEN 2:1", "the Holy Spirit"),
      targetRow("ex-1", "GEN 2:1", "Espiritu Santo"),
    ]
    renderTable({ rows, examples: new Map() })

    expect(
      document.querySelector(`[data-cell-id="cell-a"] [data-health-span="supported"]`)?.textContent,
    ).toBe("Espiritu Santo")
  })

  it("resolves persisted example text without loading cited cells", () => {
    setHealthScoreColorCoding(true)
    const rows: CellRow[] = [
      sourceRow("cell-a", "GEN 1:1", "source 0"),
      targetRow("cell-a", "GEN 1:1", "Espiritu Santo came yesterday", {
        aiDrafted: true,
        aiDraft: {
          model: "test",
          provider: "test",
          promptVersion: "v1",
          exampleIds: ["ex-other-file"],
          exampleTexts: [{ cellId: "ex-other-file", source: "the Holy Spirit", target: "Espiritu Santo" }],
          generatedAt: 1,
          mode: "single",
          projectState: {
            sourceLanguage: "en",
            targetLanguage: "fr",
            approvedExampleCount: 1,
          },
        },
      }),
    ]
    renderTable({ rows, examples: new Map() })

    expect(
      document.querySelector(`[data-cell-id="cell-a"] [data-health-span="supported"]`)?.textContent,
    ).toBe("Espiritu Santo")
  })
})
