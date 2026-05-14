import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ViolationPopover } from "./ViolationPopover"
import type { RuleInfraction, RuleWaiver } from "@/lib/parsers/types"

const infraction: RuleInfraction = {
  ruleId: "r1", cellId: "c1", fileId: "f1",
  message: `"No bad": target contains forbidden pattern`,
  spans: [{ side: "target", start: 0, end: 3, matchedText: "bad" }],
}

describe("ViolationPopover", () => {
  it("renders rule name, message, and a Waive button by default", () => {
    render(
      <ViolationPopover
        open infraction={infraction} ruleName="No bad" waivers={[]} anchor={null}
        onOpenChange={() => {}} onOpenRule={() => {}} onWaive={() => {}} onUnwaive={() => {}}
      />
    )
    expect(screen.getByText("No bad")).toBeInTheDocument()
    expect(screen.getByText(/forbidden pattern/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /waive/i })).toBeInTheDocument()
  })

  it("shows Unwaive when the rule is already waived", () => {
    const waivers: RuleWaiver[] = [{ ruleId: "r1", reason: "agreed", waivedAt: "2026-04-24T00:00:00Z" }]
    render(
      <ViolationPopover
        open infraction={infraction} ruleName="No bad" waivers={waivers} anchor={null}
        onOpenChange={() => {}} onOpenRule={() => {}} onWaive={() => {}} onUnwaive={() => {}}
      />
    )
    expect(screen.getByText(/Waived/)).toBeInTheDocument()
    expect(screen.getByText(/agreed/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /unwaive/i })).toBeInTheDocument()
  })

  it("calls onWaive with the submitted reason", () => {
    const onWaive = vi.fn()
    render(
      <ViolationPopover
        open infraction={infraction} ruleName="No bad" waivers={[]} anchor={null}
        onOpenChange={() => {}} onOpenRule={() => {}} onWaive={onWaive} onUnwaive={() => {}}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /waive/i }))
    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: "intentional" } })
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }))
    expect(onWaive).toHaveBeenCalledWith({ ruleId: "r1", reason: "intentional" })
  })
})
