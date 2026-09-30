// src/components/brief/BriefSection.test.tsx
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { BriefSection } from "./BriefSection"
import { emptyBrief } from "@/lib/brief/brief"

describe("BriefSection", () => {
  it("shows a create CTA when there is no brief", () => {
    render(<BriefSection brief={undefined} canEdit onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.getByRole("button", { name: /create brief/i })).toBeTruthy()
  })
  // AQU-912: the brief read as mandatory to two partner users (Biblica GP,
  // ETT) in two days, and ETT does not use briefs at all — so the empty state
  // must say it is optional, not just offer a CTA. Asserted on the rendered
  // string rather than the key so a copy change that drops the qualifier fails
  // here instead of shipping.
  it("marks the brief optional while none exists", () => {
    render(<BriefSection brief={undefined} canEdit onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.getByText(/\(optional\)/i)).toBeTruthy()
    expect(screen.getByText(/or skip it and start translating without one/i)).toBeTruthy()
  })
  // Once a brief exists the qualifier is noise — the decision it informs is
  // already made, and the card's own status badge carries the state.
  it("drops the optional qualifier once a brief exists", () => {
    render(<BriefSection brief={emptyBrief("a")} canEdit onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.queryByText(/\(optional\)/i)).toBeNull()
  })
  it("shows an 'out of date' badge when the L1 is stale", () => {
    render(<BriefSection brief={emptyBrief("a")} canEdit onEdit={() => {}} onGenerate={() => {}} stale />)
    expect(screen.getByText(/out of date/i)).toBeTruthy()
  })
  it("hides edit affordances for non-maintainers", () => {
    render(<BriefSection brief={emptyBrief("a")} canEdit={false} onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.queryByRole("button", { name: /edit brief/i })).toBeNull()
  })
})
