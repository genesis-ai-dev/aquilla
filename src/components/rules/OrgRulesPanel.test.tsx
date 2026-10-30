// AQU-2260 (Sam, Oct 29): a promotion request's Approve and Dismiss are
// labelled buttons, so they say nothing on hover.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips } from "@/test-utils/tooltip"
import type { PromotionRequest, TranslationRule } from "@/lib/parsers/types"
import { OrgRulesPanel } from "./OrgRulesPanel"

const rule: TranslationRule = {
  id: "r1", name: "No loanwords", description: "", severity: "minor", source: "user", scope: "project",
  enabled: true, createdAt: "2026-01-01T00:00:00.000Z", check: { type: "target-forbids", targetPattern: "x" },
}
const request: PromotionRequest = {
  id: "q1", rule, sourceProjectId: "p1", requestedBy: 4, requestedByName: "anna", requestedAt: "2026-10-01T00:00:00Z",
}

describe("OrgRulesPanel promotion requests", () => {
  it("Approve and Dismiss show nothing on hover", async () => {
    renderWithTooltips(
      <OrgRulesPanel orgRules={[]} canEdit patchOrgSettings={vi.fn()} promotionRequests={[request]} />,
    )
    const user = userEvent.setup()
    for (const name of ["Approve", "Dismiss"]) {
      await user.hover(screen.getByRole("button", { name }))
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.queryByRole("tooltip")).toBeNull()
    }
  })
})
