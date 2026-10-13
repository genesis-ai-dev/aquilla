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
  // AQU-1672: Samuel generated the summary, saw a permanent "Draft" badge with
  // no action beside it, and could not tell whether the AI was using the brief
  // at all. The status is derived (briefStatus) and there is nothing to approve,
  // so the card has to say that in words. Asserted on the rendered copy, not the
  // key, so dropping the explanation fails here instead of shipping.
  it("explains that a draft brief is already in force and needs no approval", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "Evangelistic" } }
    render(<BriefSection brief={b} canEdit onEdit={() => {}} onGenerate={() => {}} stale />)
    expect(screen.getByText(/already in force/i)).toBeTruthy()
    expect(screen.getByText(/nothing to approve/i)).toBeTruthy()
  })
  // The badge used to render the raw enum value ("draft"), untranslated and
  // unexplained — it reuses the Living Memory index's status strings now.
  it("renders the status as localized copy, never the raw enum", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "Evangelistic" } }
    render(<BriefSection brief={b} canEdit onEdit={() => {}} onGenerate={() => {}} stale />)
    expect(screen.getByText("Draft")).toBeTruthy()
    expect(screen.queryByText("draft")).toBeNull()
  })
  // AQU-1672 / AQU-827: the brief is optional for hand translation but IS a
  // start gate for autopilot, and the empty state is where that question gets
  // asked. Both facts, together, or the copy is misleading either way.
  it("says what a missing brief costs without contradicting that it is optional", () => {
    render(<BriefSection brief={undefined} canEdit onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.getByText(/\(optional\)/i)).toBeTruthy()
    expect(screen.getByText(/autopilot will not start/i)).toBeTruthy()
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
