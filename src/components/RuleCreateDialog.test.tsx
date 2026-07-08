/**
 * RuleCreateDialog.test.tsx — AQU-480 permission-gate regression guard.
 *
 * Creating a rule persists to project_settings, which the server gates at
 * MAINTAINER (600). Below that floor the trigger must be disabled-with-tooltip
 * so a contributor can't open the dialog and add a rule that silently 403s and
 * vanishes on reload.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { RuleCreateDialog } from "./RuleCreateDialog"

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

describe("RuleCreateDialog permission gate (AQU-480)", () => {
  it("disables the Add Rule trigger with a reason when canManage is false", () => {
    render(
      <RuleCreateDialog
        onAdd={vi.fn()}
        canManage={false}
        deniedReason="Only maintainers and owners can add or change translation rules."
      />,
    )
    const trigger = screen.getByRole("button", { name: /Add Rule/i })
    expect(trigger).toBeDisabled()
    expect(trigger.getAttribute("title")).toMatch(/maintainers/i)
  })

  it("enables the Add Rule trigger when canManage is true", () => {
    render(<RuleCreateDialog onAdd={vi.fn()} canManage />)
    expect(screen.getByRole("button", { name: /Add Rule/i })).not.toBeDisabled()
  })
})
