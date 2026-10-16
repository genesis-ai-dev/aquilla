/**
 * AQU-608: the editor-header TARGET-tag lane switcher is a maintainer-and-above
 * affordance. This test renders the real EditorTable with more than one lane and
 * an `onLaneChange` handler, and proves:
 *   - a maintainer (600) sees the interactive dropdown (`lane-switcher`);
 *   - a contributor (400) does NOT — the tag falls back to a static pill that
 *     still names the target language, so translators keep to their lane.
 * The dropdown UI itself landed with AQU-602; this locks in the role gate.
 */

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { ROLE } from "@/lib/frontier/roles"

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))

// happy-dom has no layout engine — replace the virtualized list with a trivial
// "render every row" stand-in (same shim as EditorTable.lane.test).
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

function makeProject(level: number, targetLanguage = "fr"): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage,
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: { level, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
  }
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
    projectId: "proj-1",
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows("cell-1"), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(
  level: number,
  targetLanguage = "fr",
  {
    lanes = ["", "es"],
    scopedLanes = null as string[] | null,
    laneLabels = undefined as Record<string, string> | undefined,
    laneCodes = undefined as Record<string, string> | undefined,
    activeLane = "",
    onAddLane = undefined as (() => void) | undefined,
  } = {},
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={makeProject(level, targetLanguage)}
          cellStore={makeStore()}
          username="tester"
          activeLane={activeLane}
          lanes={lanes}
          scopedLanes={scopedLanes}
          onLaneChange={() => {}}
          onAddLane={onAddLane}
          defaultLaneLabel="fr"
          laneLabels={laneLabels}
          laneCodes={laneCodes}
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

describe("EditorTable — lane switcher is maintainer-gated (AQU-608)", () => {
  it("shows the interactive dropdown for a maintainer", async () => {
    renderTable(ROLE.MAINTAINER)
    expect(await screen.findByTestId("lane-switcher")).toBeInTheDocument()
  })

  it("hides the switcher for a contributor, leaving a static target-language pill", async () => {
    renderTable(ROLE.CONTRIBUTOR)
    // The row renders (proves the header mounted) but no lane switcher exists…
    await screen.findByText("bonjour")
    expect(screen.queryByTestId("lane-switcher")).not.toBeInTheDocument()
    // …and the target language is still shown as a plain pill.
    expect(screen.getByText("fr")).toBeInTheDocument()
  })

  it("names the static pill from the lane label, the same way the switcher does", async () => {
    renderTable(ROLE.CONTRIBUTOR, "fr", { laneLabels: { "": "Spanish" } })
    await screen.findByText("bonjour")
    expect(screen.queryByTestId("lane-switcher")).not.toBeInTheDocument()
    expect(screen.getByText("Spanish")).toBeInTheDocument()
  })

  // AQU-583: with extra lanes registered but no default target language set, the
  // switcher must still be reachable so the named lanes aren't stranded — the
  // trigger prompts to set the default rather than showing a blank pill.
  it("shows the switcher for a maintainer even with no default target language", async () => {
    renderTable(ROLE.MAINTAINER, "")
    const switcher = await screen.findByTestId("lane-switcher")
    expect(switcher).toBeInTheDocument()
    expect(switcher).toHaveTextContent("Set target language")
  })
})

// A member the org limited to certain lanes (AQU-553) is below MAINTAINER, so
// AQU-608 alone would leave them on the default lane with no way to their own —
// a lane coordinator (AQU-581) couldn't open the lane they hand work out in.
describe("EditorTable — a lane-limited member switches among their own lanes", () => {
  it("offers a contributor limited to two lanes a switcher with only those lanes", async () => {
    renderTable(ROLE.CONTRIBUTOR, "fr", { lanes: ["", "es", "de"], scopedLanes: ["es", "de"] })
    fireEvent.click(await screen.findByTestId("lane-switcher"))
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent)
    expect(options).toEqual(["es", "de"])
  })

  it("offers a contributor limited to one lane a switcher with only that lane, and no Add lane", async () => {
    const onAddLane = vi.fn()
    renderTable(ROLE.CONTRIBUTOR, "fr", { lanes: ["", "es", "de"], scopedLanes: ["es"], onAddLane })
    fireEvent.click(await screen.findByTestId("lane-switcher"))
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent)
    expect(options).toEqual(["es"])
    expect(screen.queryByTestId("add-lane")).not.toBeInTheDocument()
    expect(onAddLane).not.toHaveBeenCalled()
  })

  it("shows a one-lane maintainer the switcher and Add lane", async () => {
    const onAddLane = vi.fn()
    renderTable(ROLE.MAINTAINER, "fr", { lanes: [""], onAddLane })
    fireEvent.click(await screen.findByTestId("lane-switcher"))
    fireEvent.click(screen.getByTestId("add-lane"))
    expect(onAddLane).toHaveBeenCalledTimes(1)
  })

  it("keeps every lane for a maintainer, whatever the scopes say", async () => {
    renderTable(ROLE.MAINTAINER, "fr", { lanes: ["", "es", "de"], scopedLanes: ["es"] })
    fireEvent.click(await screen.findByTestId("lane-switcher"))
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["fr", "es", "de"])
  })
})

// AQU-1784: a lane's label is its name, else its language, and nothing makes
// that unique. Two "Tshangla" lanes rendered as identical switcher rows and an
// identical TARGET pill, so two people reading different lanes — different
// cells, different progress — saw the same screen. The switcher and the pill
// now carry a suffix, and it is computed over the lanes the READER can see so
// a walled member is told nothing about a sibling lane (AQU-1421).
describe("EditorTable — two lanes with the same label are told apart (AQU-1784)", () => {
  const COLLIDING = {
    lanes: ["Tshangla", "a3f09c1e"],
    laneLabels: { Tshangla: "Tshangla", a3f09c1e: "Tshangla" },
  }

  it("numbers the second colliding lane in the switcher", async () => {
    renderTable(ROLE.MAINTAINER, "fr", { ...COLLIDING, activeLane: "Tshangla" })
    fireEvent.click(await screen.findByTestId("lane-switcher"))
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Tshangla",
      "Tshangla · 2",
    ])
  })

  it("shows the active lane's disambiguated label on the TARGET pill", async () => {
    // Step 4 of the report: switching lanes must visibly change the pill.
    renderTable(ROLE.MAINTAINER, "fr", { ...COLLIDING, activeLane: "a3f09c1e" })
    expect(await screen.findByTestId("lane-switcher")).toHaveTextContent("Tshangla · 2")
  })

  it("prefers a colliding lane's code override to its position", async () => {
    renderTable(ROLE.MAINTAINER, "fr", {
      ...COLLIDING,
      laneCodes: { a3f09c1e: "tsj" },
      activeLane: "a3f09c1e",
    })
    const switcher = await screen.findByTestId("lane-switcher")
    expect(switcher).toHaveTextContent("Tshangla · tsj")
    fireEvent.click(switcher)
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Tshangla",
      "Tshangla · tsj",
    ])
  })

  it("leaves a lane whose label is unique with no suffix", async () => {
    renderTable(ROLE.MAINTAINER, "fr", {
      lanes: ["Tshangla", "fr"],
      laneLabels: { Tshangla: "Tshangla", fr: "French" },
      activeLane: "Tshangla",
    })
    const switcher = await screen.findByTestId("lane-switcher")
    expect(switcher).toHaveTextContent("Tshangla")
    expect(switcher).not.toHaveTextContent("·")
  })

  it("gives a member who can see only one of the colliding lanes no suffix", async () => {
    // The suffix would otherwise announce that a second Tshangla lane exists.
    renderTable(ROLE.CONTRIBUTOR, "fr", {
      ...COLLIDING,
      scopedLanes: ["a3f09c1e"],
      activeLane: "a3f09c1e",
    })
    const switcher = await screen.findByTestId("lane-switcher")
    expect(switcher).toHaveTextContent("Tshangla")
    expect(switcher).not.toHaveTextContent("·")
    fireEvent.click(switcher)
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Tshangla"])
  })

  it("gives a contributor with no lane scope a static pill with no suffix", async () => {
    // No switcher at all: the pill names the one lane they are in, and the
    // colliding sibling is not in the list it is computed from.
    renderTable(ROLE.CONTRIBUTOR, "fr", { ...COLLIDING, activeLane: "a3f09c1e" })
    await screen.findByText("bonjour")
    expect(screen.queryByTestId("lane-switcher")).not.toBeInTheDocument()
    expect(screen.getByText("Tshangla")).toBeInTheDocument()
  })
})
