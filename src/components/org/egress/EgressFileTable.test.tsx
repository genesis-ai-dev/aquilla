// Egress file-table selection. The business rules pinned here:
// - the header "Select all files" checkbox operates on the FILTERED rows only,
//   so a user can filter to one project and bulk-select/deselect just it
//   without silently nuking selections outside the filter (what they'd export
//   would otherwise not match what they see);
// - per-row checkboxes toggle exactly one file;
// - "Clear selection" empties everything regardless of filter.

import { describe, it, expect } from "vitest"
import { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { EgressFileTable } from "./EgressFileTable"
import type { EgressFileRow } from "@/hooks/useOrgEgressData"

function row(overrides: Partial<EgressFileRow> & { fileId: string }): EgressFileRow {
  return {
    fileName: `${overrides.fileId}.usfm`,
    fileType: "usfm",
    projectId: "p1",
    projectName: "Genesis",
    cellCount: 10,
    sourceLanguage: "en",
    targetLanguage: "sw",
    lanes: [{ lane: "", totalCells: 10, filledCells: 5, validatedCells: 2, lastEditAt: null }],
    hasAudio: false,
    lastEditAt: null,
    ...overrides,
  }
}

const ROWS: EgressFileRow[] = [
  row({ fileId: "a", fileName: "a.usfm", projectId: "p1", projectName: "Genesis" }),
  row({ fileId: "b", fileName: "b.usfm", projectId: "p1", projectName: "Genesis" }),
  row({ fileId: "c", fileName: "c.docx", fileType: "docx", projectId: "p2", projectName: "Handbook" }),
]

function Harness({ initial = [] }: { initial?: string[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial))
  return <EgressFileTable rows={ROWS} selected={selected} onSelectedChange={setSelected} />
}

function checkbox(name: string): HTMLElement {
  return screen.getByRole("checkbox", { name })
}

describe("EgressFileTable selection", () => {
  it("toggles a single file via its row checkbox", () => {
    render(<Harness />)

    fireEvent.click(checkbox("Select a.usfm"))
    expect(screen.getByTestId("egress-selected-count")).toHaveTextContent("1 of 3 selected")
    expect(checkbox("Select a.usfm")).toHaveAttribute("aria-checked", "true")
    expect(checkbox("Select b.usfm")).toHaveAttribute("aria-checked", "false")

    fireEvent.click(checkbox("Select a.usfm"))
    expect(screen.getByTestId("egress-selected-count")).toHaveTextContent("0 of 3 selected")
  })

  it("header select-all with no filter selects every row", () => {
    render(<Harness />)

    fireEvent.click(checkbox("Select all files"))

    expect(screen.getByTestId("egress-selected-count")).toHaveTextContent("3 of 3 selected")
    expect(checkbox("Select all files")).toHaveAttribute("aria-checked", "true")
  })

  it("header select-all while filtered adds only the visible rows", () => {
    render(<Harness />)

    fireEvent.change(screen.getByLabelText("Filter files…"), { target: { value: "Genesis" } })
    fireEvent.click(checkbox("Select all files"))

    // Both Genesis files selected, the Handbook file untouched.
    expect(screen.getByTestId("egress-selected-count")).toHaveTextContent("2 of 3 selected")
    fireEvent.change(screen.getByLabelText("Filter files…"), { target: { value: "" } })
    expect(checkbox("Select a.usfm")).toHaveAttribute("aria-checked", "true")
    expect(checkbox("Select b.usfm")).toHaveAttribute("aria-checked", "true")
    expect(checkbox("Select c.docx")).toHaveAttribute("aria-checked", "false")
  })

  it("header deselect-all while filtered keeps selections outside the filter", () => {
    render(<Harness initial={["a", "b", "c"]} />)

    fireEvent.change(screen.getByLabelText("Filter files…"), { target: { value: "Genesis" } })
    // All filtered rows are selected → the header checkbox reads checked, and
    // clicking it deselects only those rows.
    expect(checkbox("Select all files")).toHaveAttribute("aria-checked", "true")
    fireEvent.click(checkbox("Select all files"))

    expect(screen.getByTestId("egress-selected-count")).toHaveTextContent("1 of 3 selected")
    fireEvent.change(screen.getByLabelText("Filter files…"), { target: { value: "" } })
    expect(checkbox("Select c.docx")).toHaveAttribute("aria-checked", "true")
  })

  it("shows the header checkbox as mixed when only some filtered rows are selected", () => {
    render(<Harness initial={["a"]} />)

    expect(checkbox("Select all files")).toHaveAttribute("aria-checked", "mixed")
  })

  it("renders the mixed header state visually distinct from fully-checked (minus glyph)", () => {
    render(<Harness initial={["a"]} />)

    // Partial selection: a minus, NOT the check a fully-selected header shows.
    const header = checkbox("Select all files")
    expect(header.querySelector("svg.lucide-minus")).not.toBeNull()
    expect(header.querySelector("svg.lucide-check")).toBeNull()

    // Select everything: the glyph flips to the check (re-query — the header
    // cell re-renders).
    fireEvent.click(header)
    const checkedHeader = checkbox("Select all files")
    expect(checkedHeader.querySelector("svg.lucide-check")).not.toBeNull()
    expect(checkedHeader.querySelector("svg.lucide-minus")).toBeNull()
  })

  it("'Clear selection' empties the whole selection regardless of filter", () => {
    render(<Harness initial={["a", "c"]} />)

    fireEvent.change(screen.getByLabelText("Filter files…"), { target: { value: "Genesis" } })
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))

    expect(screen.getByTestId("egress-selected-count")).toHaveTextContent("0 of 3 selected")
  })
})
