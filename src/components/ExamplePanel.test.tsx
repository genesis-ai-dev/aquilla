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
    source: "In the beginning God created",
    target: "Al inicio Dios creó",
    score: 0.9,
    matchedTokens: ["god", "created"],
  },
  {
    cellId: "cell-2",
    source: "God said let there be light",
    target: "Dios dijo que haya luz",
    score: 0.7,
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

  it("renders nothing when there are no examples", () => {
    const { container } = render(<ExamplePanel examples={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
