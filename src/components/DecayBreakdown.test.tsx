import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DecayBreakdown } from "./DecayBreakdown"
import { createHealthCardNamer, healthCardRows } from "@/lib/health/health-card-rows"
import { lineStore, type TestLine, LINE_WORDS } from "@/test-utils/line-store"
import type { CellStore } from "@/hooks/useActiveCellStore"
import type { OrderedBy } from "@/lib/parsers/types"

// AQU-2278: the card's "Biggest drags" named lines by their raw cell id
// ("01a1…") whenever a line had no stored label, which is most lines.

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-slot="popover-trigger"]')!
}

function Card(props: {
  rows: Array<{ cellId: string; health: number }>
  nameCells: (ids: readonly string[]) => string[]
  onJumpToCell?: (id: string) => void
}) {
  return (
    <DecayBreakdown
      health={40}
      scopeLabel="Project health"
      label="Project health: 40%"
      getHealthByCell={() => props.rows}
      nameCells={props.nameCells}
      onJumpToCell={props.onJumpToCell ?? vi.fn()}
    >
      <span>ring</span>
    </DecayBreakdown>
  )
}

/** The card as the workspace wires it, over a real store. */
function WorkspaceCard({ store, health, countStructural = true, orderedBy, onJumpToCell, namer }: {
  store: CellStore
  health: Map<string, number>
  countStructural?: boolean
  orderedBy?: OrderedBy
  onJumpToCell?: (id: string) => void
  namer?: ReturnType<typeof createHealthCardNamer>
}) {
  const name = namer ?? createHealthCardNamer(store)
  return (
    <Card
      rows={healthCardRows(store.getAllSummaries(), health, countStructural)}
      nameCells={(ids) => name(ids, orderedBy, LINE_WORDS)}
      onJumpToCell={onJumpToCell}
    />
  )
}

function dragNames(): string[] {
  return screen.getAllByRole("button").filter((b) => /%$/.test(b.textContent ?? ""))
    .map((b) => b.querySelector("span")!.textContent ?? "")
}

describe("DecayBreakdown biggest drags", () => {
  it("names only the drags it shows, worst first", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ cellId: `c${i}`, health: 30 - i }))
    const nameCells = vi.fn((ids: readonly string[]) => ids.map((id) => `name of ${id}`))
    const { container } = render(<Card rows={rows} nameCells={nameCells} />)
    fireEvent.click(trigger(container))
    await screen.findByRole("button", { name: /name of c11.*19%/ })
    expect(nameCells).toHaveBeenCalledTimes(1)
    expect(nameCells.mock.calls[0][0]).toEqual(["c11", "c10", "c9", "c8", "c7", "c6", "c5", "c4"])
  })

  it("reads a timecode left to right, and lets any other name take its own direction", async () => {
    const rows = [{ cellId: "cue", health: 5 }, { cellId: "verse", health: 6 }]
    const names: Record<string, string> = { cue: "00:00:01.000 --> 00:00:03.500", verse: "RUT 1:4" }
    const { container } = render(<Card rows={rows} nameCells={(ids) => ids.map((id) => names[id])} />)
    fireEvent.click(trigger(container))
    expect((await screen.findByText(names.cue)).getAttribute("dir")).toBe("ltr")
    expect(screen.getByText("RUT 1:4").getAttribute("dir")).toBe("auto")
  })

  it("names unlabelled Bible lines by their references in a real store, and opens the one clicked", async () => {
    const lines: TestLine[] = [
      { id: "title", type: "heading", ref: "RUT 1:h:1", text: "Naomi and Ruth" },
      { id: "01a1b2c3-0000-7000-8000-000000000004", ref: "RUT 1:4" },
      { id: "v5", ref: "RUT 1:5" },
      { id: "v5-b", splitFrom: "v5" },
      { id: "parked", ref: "RUT 1:7", hidden: true },
    ]
    const store = lineStore(lines)
    const health = new Map(lines.map((l, i) => [l.id, i]))
    const onJumpToCell = vi.fn()
    const { container } = render(
      <WorkspaceCard store={store} health={health} countStructural={false} onJumpToCell={onJumpToCell} />,
    )
    fireEvent.click(trigger(container))
    const ruth = await screen.findByRole("button", { name: /RUT 1:4.*1%/ })
    // The heading is left out under "don't count headings", and a parked line
    // is never work, as the footer's number beside the card counts them.
    expect(dragNames()).toEqual(["RUT 1:4", "RUT 1:5a", "RUT 1:5b"])
    expect(screen.queryByText(/01a1b2c3/)).toBeNull()
    fireEvent.click(ruth)
    expect(onJumpToCell).toHaveBeenCalledWith("01a1b2c3-0000-7000-8000-000000000004")
  })

  it("counts a heading when the project counts headings, named by its words since it has no number", async () => {
    const lines: TestLine[] = [
      { id: "title", type: "heading", ref: "RUT 1:h:1", text: "Naomi and Ruth" },
      { id: "v1", ref: "RUT 1:1" },
    ]
    const store = lineStore(lines)
    const { container } = render(<WorkspaceCard store={store} health={new Map([["title", 0], ["v1", 1]])} />)
    fireEvent.click(trigger(container))
    await screen.findByRole("button", { name: /RUT 1:1/ })
    expect(dragNames()).toEqual(["Naomi and Ruth", "RUT 1:1"])
  })

  it("does not re-sort a time-ordered file each time the card opens", async () => {
    const lines: TestLine[] = [{ id: "late", startMs: 9000 }, { id: "early", startMs: 1000 }, { id: "plain" }]
    const store = lineStore(lines)
    const lens = vi.spyOn(store, "getCellIdsForLens")
    const namer = createHealthCardNamer(store)
    const health = new Map([["late", 1], ["early", 2], ["plain", 3]])
    const { container } = render(<WorkspaceCard store={store} health={health} orderedBy="time" namer={namer} />)
    fireEvent.click(trigger(container))
    await screen.findByRole("button", { name: /00:00:09/ })
    fireEvent.click(trigger(container))
    fireEvent.click(trigger(container))
    await screen.findByRole("button", { name: /00:00:09/ })
    expect(lens.mock.calls.filter(([orderedBy]) => orderedBy === "time")).toHaveLength(1)
  })
})
