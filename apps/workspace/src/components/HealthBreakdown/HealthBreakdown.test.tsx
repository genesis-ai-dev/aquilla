import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { HealthBreakdown } from "./HealthBreakdown"
import type { CellHealthBreakdown } from "@/lib/parsers/types"

const MOCK_BREAKDOWN: CellHealthBreakdown = {
  cellId: "a", score: 72,
  validationGap: 0, ancestryPenalty: 5, neighborhoodPenalty: 15, rulePenalty: 8,
  signals: {
    validatorCount: 2, requiredValidations: 2,
    ancestryExamples: [{ cellId: "p1", health: 100, weight: 0.8 }],
    neighborhoodSourceCellIds: ["n1", "n2"], neighborhoodTargetCellIds: ["n1", "n3"],
    idJaccard: 0.4, tfidfTokenOverlap: 0.55,
    infractions: [],
  },
}

describe("HealthBreakdown", () => {
  it("renders children as the hover target", () => {
    render(
      <HealthBreakdown breakdown={MOCK_BREAKDOWN} scopeLabel="cell health" majorInfractionCount={0}>
        <span data-testid="ring">RING</span>
      </HealthBreakdown>
    )
    expect(screen.getByTestId("ring")).toBeInTheDocument()
  })

  it("opens the popover when the chevron is clicked", () => {
    render(
      <HealthBreakdown breakdown={MOCK_BREAKDOWN} scopeLabel="cell health" majorInfractionCount={0}>
        <span data-testid="ring">RING</span>
      </HealthBreakdown>
    )
    fireEvent.click(screen.getByRole("button", { name: /breakdown detail/i }))
    expect(screen.getByText("cell health")).toBeInTheDocument()
    expect(screen.getByText("Reviewed")).toBeInTheDocument()
    expect(screen.getByText("Consistency")).toBeInTheDocument()
  })

  it("invokes onCellClick when an ancestry example is clicked", () => {
    const onCellClick = vi.fn()
    render(
      <HealthBreakdown breakdown={MOCK_BREAKDOWN} scopeLabel="cell health" majorInfractionCount={0} onCellClick={onCellClick}>
        <span data-testid="ring">RING</span>
      </HealthBreakdown>
    )
    fireEvent.click(screen.getByRole("button", { name: /breakdown detail/i }))
    fireEvent.click(screen.getByRole("button", { name: "p1" }))
    expect(onCellClick).toHaveBeenCalledWith("p1")
  })
})
