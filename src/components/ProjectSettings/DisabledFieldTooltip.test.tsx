import { describe, it, expect, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "@/components/ui/button"
import {
  DisabledFieldTooltip,
  PermissionLockHint,
} from "./DisabledFieldTooltip"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

describe("DisabledFieldTooltip", () => {
  it("does not wrap children when the field is editable", () => {
    renderWithTooltips(
      <DisabledFieldTooltip disabled={false} tooltip="Only Maintainers can modify">
        <Button>Edit</Button>
      </DisabledFieldTooltip>,
    )
    expect(screen.getByRole("button", { name: "Edit" })).not.toBeDisabled()
  })

  it("shows a compact permission hint with a next-action link on a locked control", async () => {
    renderWithTooltips(
      <DisabledFieldTooltip
        disabled
        tooltip={
          <PermissionLockHint
            title="Only Maintainers can modify"
            href="https://help.aquilla.app/permissions"
            linkLabel="Learn about permission levels"
          />
        }
      >
        <Button disabled>Edit</Button>
      </DisabledFieldTooltip>,
    )
    const trigger = screen.getByRole("button", { name: "Edit" })
    expect(trigger).toBeDisabled()
    await expectTooltip(trigger, /Only Maintainers can modify/)
    const docs = screen.getByRole("button", { name: /learn about permission levels/i })
    expect(docs).toHaveAttribute("href", "https://help.aquilla.app/permissions")
    expect(docs).toHaveAttribute("target", "_blank")
    expect(docs).toHaveAttribute("data-variant", "ghost")
    expect(docs).toHaveClass("text-xs", "-mx-1.5", "px-1.5")
    expect(screen.getByRole("tooltip")).toHaveClass("text-xs", "p-2")
    expect(screen.getByText("Only Maintainers can modify").parentElement).toHaveClass(
      "items-start",
    )
    expect(screen.getByRole("tooltip").closest("[data-align]")).toHaveAttribute(
      "data-align",
      "center",
    )
  })

  it("opens the privileged-members modal from View Maintainers, without navigating", async () => {
    const onView = vi.fn()
    renderWithTooltips(
      <DisabledFieldTooltip
        disabled
        tooltip={
          <PermissionLockHint
            title="Only Maintainers can modify"
            onView={onView}
            linkLabel="View Maintainers"
          />
        }
      >
        <Button disabled>Edit</Button>
      </DisabledFieldTooltip>,
    )
    await expectTooltip(screen.getByRole("button", { name: "Edit" }), /Only Maintainers can modify/)
    const action = screen.getByRole("button", { name: /view maintainers/i })
    expect(action).toHaveAttribute("data-variant", "ghost")
    expect(action).toHaveClass("text-xs", "-mx-1.5", "px-1.5")
    await userEvent.click(action)
    expect(onView).toHaveBeenCalledOnce()
  })
})
