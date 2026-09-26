// WHY: The examples popover must surface BOTH source and target text for each
// example so translators can see the paired context they're referencing. A
// popover (not an inline dropdown) prevents it from crowding the center dot
// between the source and target columns.

import { describe, it, expect } from "vitest"
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

describe("ExamplePanel", () => {
  it("renders a trigger button with the example count", () => {
    render(<ExamplePanel examples={examples} />)
    expect(screen.getByRole("button", { name: /2 examples/i })).toBeInTheDocument()
  })

  it("shows both source AND target text for each example when the popover is opened", async () => {
    render(<ExamplePanel examples={examples} />)

    fireEvent.click(screen.getByRole("button", { name: /2 examples/i }))

    // Both source texts must be visible
    expect(await screen.findByText(/In the beginning God created/)).toBeInTheDocument()
    expect(await screen.findByText(/God said let there be light/)).toBeInTheDocument()

    // Both target texts must also be visible — this is the key requirement:
    // translators need the paired translation, not just the source
    expect(await screen.findByText(/Al inicio Dios creó/)).toBeInTheDocument()
    expect(await screen.findByText(/Dios dijo que haya luz/)).toBeInTheDocument()
  })

  // WHY (AQU-1264): the popup is portalled and position-fixed, so an unbounded
  // list of long example pairs simply runs off the bottom of the viewport with
  // nothing to scroll — the page behind it scrolls instead. The height cap and
  // the scroller must sit on the element that actually holds the examples, not
  // on a wrapper, or the content still overflows past the cap.
  it("caps the examples popup to the available height and scrolls it in place", async () => {
    render(<ExamplePanel examples={examples} />)

    fireEvent.click(screen.getByRole("button", { name: /2 examples/i }))
    await screen.findByText(/In the beginning God created/)

    const popup = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
    expect(popup).not.toBeNull()
    // the examples live inside the element carrying the scroll affordances
    expect(popup!).toContainElement(screen.getByText(/God said let there be light/))

    const classes = popup!.className
    expect(classes).toContain("max-h-(--available-height)")
    expect(classes).toContain("overflow-y-auto")
    // wheel/trackpad momentum must not chain into the editor grid behind it
    expect(classes).toContain("overscroll-contain")
  })

  it("renders nothing when there are no examples", () => {
    const { container } = render(<ExamplePanel examples={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
