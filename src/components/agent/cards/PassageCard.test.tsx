/**
 * PassageCard — inline passage view with in-card navigation (agent-complete
 * design §5). The card shows what the tool displayed, lets the user move
 * (side toggle, chapter ‹ ›) WITHOUT an agent round-trip, and reports its
 * current view through onActivity so the model hears about it next turn.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { PassageRow } from "@/lib/agent/protocol"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { PassageCard, pairCellRows, parseChapterRef } from "./PassageCard"

const rows: PassageRow[] = [
  { cellId: "c1", fileId: "f1", ref: "MRK 4:1", source: "Again he began to teach", target: "Di nuovo insegnava" },
  { cellId: "c2", fileId: "f1", ref: "MRK 4:2", source: "And he taught them", target: "" },
]

const cellRow = (over: Partial<CellRow>): CellRow => ({
  cellId: "x",
  side: "source",
  value: "",
  valueHtml: null,
  type: null,
  canonicalRef: null,
  anchorCellId: null,
  eventId: "e",
  sourceEventId: null,
  lastEditor: null,
  lastEditAt: 0,
  validated: false,
  wordCount: 0,
  ...over,
})

describe("parseChapterRef / pairCellRows", () => {
  it("parses scripture refs and rejects non-scripture ones", () => {
    expect(parseChapterRef("MRK 4:35")).toEqual({ book: "MRK", chapter: 4 })
    expect(parseChapterRef("1CO 15:10")).toEqual({ book: "1CO", chapter: 15 })
    expect(parseChapterRef("segment 8")).toBeNull()
    expect(parseChapterRef(undefined)).toBeNull()
  })

  it("pairs side-split cell rows by cellId", () => {
    const paired = pairCellRows([
      cellRow({ cellId: "c9", side: "source", value: "src", canonicalRef: "MRK 5:1" }),
      cellRow({ cellId: "c9", side: "target", value: "tgt" }),
    ])
    expect(paired).toEqual([{ cellId: "c9", ref: "MRK 5:1", source: "src", target: "tgt" }])
  })
})

describe("PassageCard", () => {
  it("renders the tool's rows and reports a side switch as activity", () => {
    const onActivity = vi.fn()
    render(<PassageCard cardKey="k1" rows={rows} projectId="p1" jwt="jwt" onActivity={onActivity} />)

    expect(screen.getByText("Again he began to teach")).toBeInTheDocument()
    expect(screen.getByText("Di nuovo insegnava")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Target" }))
    // Source text hidden; the model gets ONE coalesced note keyed to the card.
    expect(screen.queryByText("Again he began to teach")).not.toBeInTheDocument()
    expect(onActivity).toHaveBeenCalledWith(
      "passage:k1",
      expect.stringMatching(/MRK 4:1 – MRK 4:2.*target side/),
    )
  })

  it("navigates chapters via a one-time client fetch and reports the new view", async () => {
    const onActivity = vi.fn()
    const fetchCells = vi.fn(async (): Promise<CellRow[]> => [
      cellRow({ cellId: "c1", side: "source", value: "ch4 src", canonicalRef: "MRK 4:1" }),
      cellRow({ cellId: "c10", side: "source", value: "A great storm arose", canonicalRef: "MRK 5:1" }),
      cellRow({ cellId: "c10", side: "target", value: "Una tempesta", canonicalRef: "MRK 5:1" }),
    ])
    render(
      <PassageCard cardKey="k2" rows={rows} projectId="p1" jwt="jwt" onActivity={onActivity} fetchCells={fetchCells} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }))
    await waitFor(() => expect(screen.getByText("A great storm arose")).toBeInTheDocument())
    expect(screen.queryByText("Again he began to teach")).not.toBeInTheDocument()
    expect(fetchCells).toHaveBeenCalledTimes(1)
    expect(onActivity).toHaveBeenLastCalledWith("passage:k2", expect.stringContaining("MRK 5:1"))

    // Second navigation reuses the cached fetch.
    fireEvent.click(screen.getByRole("button", { name: "Previous chapter" }))
    await waitFor(() => expect(screen.getByText("ch4 src")).toBeInTheDocument())
    expect(fetchCells).toHaveBeenCalledTimes(1)
  })

  it("is a static card without a jwt (no nav affordances)", () => {
    render(<PassageCard cardKey="k3" rows={rows} projectId="p1" jwt={null} />)
    expect(screen.queryByRole("button", { name: "Next chapter" })).toBeNull()
  })

  it("caps long passages and expands on demand", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      cellId: `m${i}`,
      ref: `MRK 4:${i + 1}`,
      source: `v${i + 1}`,
      target: "",
    }))
    render(<PassageCard cardKey="k4" rows={many} projectId="p1" jwt={null} />)
    expect(screen.queryByText("v20")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/8 more — show all/))
    expect(screen.getByText("v20")).toBeInTheDocument()
  })
})
