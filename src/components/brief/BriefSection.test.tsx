// src/components/brief/BriefSection.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { BriefSection } from "./BriefSection"
import { emptyBrief } from "@/lib/brief/brief"

describe("BriefSection", () => {
  it("shows a create CTA when there is no brief", () => {
    render(<BriefSection brief={undefined} canEdit onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.getByRole("button", { name: /create brief/i })).toBeTruthy()
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
