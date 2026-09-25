// WHY: The examples popover must surface BOTH source and target text for each
// example so translators can see the paired context they're referencing. A
// popover (not an inline dropdown) prevents it from crowding the center dot
// between the source and target columns.
//
// AQU-1393: it must ALSO read as a translation memory — a match percentage per
// row, the closest match first, the differing words marked, the origin named,
// and a one-click Insert on an exact match only.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ExamplePanel } from "./ExamplePanel"
import type { ScoredPair } from "@/lib/search/dual-index"

const examples: ScoredPair[] = [
  {
    cellId: "cell-1",
    fileId: "file-1",
    source: "In the beginning God created",
    target: "Al inicio Dios creó",
    score: 0.9,
    coverageWeight: 1,
    matchedTokens: ["god", "created"],
  },
  {
    cellId: "cell-2",
    fileId: "file-1",
    source: "God said let there be light",
    target: "Dios dijo que haya luz",
    score: 0.7,
    coverageWeight: 1,
    matchedTokens: ["god"],
  },
]

function open() {
  fireEvent.click(screen.getByRole("button", { name: /2 examples/i }))
}

describe("ExamplePanel", () => {
  it("renders a trigger button with the example count", () => {
    render(<ExamplePanel examples={examples} />)
    expect(screen.getByRole("button", { name: /2 examples/i })).toBeInTheDocument()
  })

  it("shows both source AND target text for each example when the popover is opened", async () => {
    render(<ExamplePanel examples={examples} />)

    open()

    // Both source texts must be visible
    expect(await screen.findByText(/In the beginning God created/)).toBeInTheDocument()
    expect(await screen.findByText(/God said let there be light/)).toBeInTheDocument()

    // Both target texts must also be visible — this is the key requirement:
    // translators need the paired translation, not just the source
    expect(await screen.findByText(/Al inicio Dios creó/)).toBeInTheDocument()
    expect(await screen.findByText(/Dios dijo que haya luz/)).toBeInTheDocument()
  })

  it("renders nothing when there are no examples", () => {
    const { container } = render(<ExamplePanel examples={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("shows no match badges without a current source to measure against", async () => {
    render(<ExamplePanel examples={examples} />)
    open()
    await screen.findByText(/In the beginning God created/)
    expect(screen.queryByTestId("example-match-badge")).not.toBeInTheDocument()
  })

  describe("TM-style matches (AQU-1393)", () => {
    it("badges each row and orders the closest match first", async () => {
      render(
        <ExamplePanel examples={examples} currentSource="In the beginning God created!" />,
      )
      open()
      const badges = await screen.findAllByTestId("example-match-badge")
      expect(badges[0]).toHaveTextContent(/9\d% match/)
      // The unrelated pair stays in the list but is labelled an example, not a
      // percentage — a sub-75% number would be false precision.
      expect(badges[1]).toHaveTextContent(/example/i)
      const rows = screen.getAllByTestId("example-row")
      expect(rows[0]).toHaveTextContent("In the beginning God created")
    })

    it("calls an identical source a 100% match", async () => {
      render(
        <ExamplePanel examples={examples} currentSource="in the   beginning god created" />,
      )
      open()
      expect((await screen.findAllByTestId("example-match-badge"))[0])
        .toHaveTextContent("100% match")
    })

    it("marks the words that differ between the match and the current cell", async () => {
      render(
        <ExamplePanel examples={examples} currentSource="In the beginning God formed" />,
      )
      open()
      const diff = (await screen.findAllByTestId("example-diff"))[0]
      // "created" is only in the match; "formed" only in the cell being translated.
      expect(diff.querySelector("ins")).toHaveTextContent("created")
      expect(diff.querySelector("del")).toHaveTextContent("formed")
    })

    it("offers Insert on an exact match only, and inserts that row's target", async () => {
      const onInsert = vi.fn()
      render(
        <ExamplePanel
          examples={examples}
          currentSource="In the beginning God created"
          onInsert={onInsert}
        />,
      )
      open()
      const insert = await screen.findByTestId("example-insert")
      fireEvent.click(insert)
      expect(onInsert).toHaveBeenCalledTimes(1)
      expect(onInsert).toHaveBeenCalledWith("Al inicio Dios creó")
      // Only the exact row gets the action.
      expect(screen.getAllByTestId("example-insert")).toHaveLength(1)
    })

    it("hides Insert when the row cannot be written to", async () => {
      render(
        <ExamplePanel examples={examples} currentSource="In the beginning God created" />,
      )
      open()
      await screen.findAllByTestId("example-match-badge")
      expect(screen.queryByTestId("example-insert")).not.toBeInTheDocument()
    })

    it("names an imported TMX file as the origin of its matches", async () => {
      render(
        <ExamplePanel
          examples={examples}
          currentSource="In the beginning God created"
          originFor={(fileId) => ({
            fileName: fileId === "file-1" ? "legacy-memory.tmx" : "Genesis",
            isTranslationMemory: fileId === "file-1",
          })}
        />,
      )
      open()
      const origins = await screen.findAllByTestId("example-origin")
      expect(origins[0]).toHaveTextContent("TM · legacy-memory.tmx")
    })

    it("names a project file as the origin without the TM marker", async () => {
      render(
        <ExamplePanel
          examples={examples}
          currentSource="In the beginning God created"
          originFor={() => ({ fileName: "Genesis", isTranslationMemory: false })}
        />,
      )
      open()
      const origins = await screen.findAllByTestId("example-origin")
      expect(origins[0]).toHaveTextContent("Genesis")
      expect(origins[0]).not.toHaveTextContent("TM ·")
    })
  })
})
