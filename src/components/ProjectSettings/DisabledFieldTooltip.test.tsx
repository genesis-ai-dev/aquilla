// AQU-2260 (Sam, Oct 29, Settings cleanup section 1, option A): a locked
// control says why in one short line beneath it — never on hover — and a card
// locked as a whole says so once under its heading, with nothing repeated
// inside it.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { DisabledFieldTooltip, PermissionLockHint } from "./DisabledFieldTooltip"

describe("DisabledFieldTooltip", () => {
  it("draws the control alone when it is editable", () => {
    render(
      <DisabledFieldTooltip disabled={false} tooltip="Only Maintainers can change this.">
        <Button>Edit</Button>
      </DisabledFieldTooltip>,
    )
    expect(screen.getByRole("button", { name: "Edit" })).not.toBeDisabled()
    expect(screen.queryByText("Only Maintainers can change this.")).toBeNull()
  })

  it("locked: one line beneath the control says who can change it, with no hover", async () => {
    render(
      <DisabledFieldTooltip disabled tooltip={<PermissionLockHint role="Maintainers" href="https://help.aquilla.app/permissions" linkLabel="Learn about permission levels" />}>
        <Button disabled>Edit</Button>
      </DisabledFieldTooltip>,
    )
    expect(screen.getByText("Only Maintainers can change this.")).toBeVisible()
    const docs = screen.getByRole("button", { name: /learn about permission levels/i })
    expect(docs).toHaveAttribute("href", "https://help.aquilla.app/permissions")
    expect(docs).toHaveAttribute("target", "_blank")
    await userEvent.setup().hover(screen.getByRole("button", { name: "Edit" }))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  it("opens the privileged-members list from View Maintainers, without navigating", async () => {
    const onView = vi.fn()
    render(
      <DisabledFieldTooltip disabled tooltip={<PermissionLockHint role="Maintainers" onView={onView} linkLabel="View Maintainers" />}>
        <Button disabled>Edit</Button>
      </DisabledFieldTooltip>,
    )
    await userEvent.click(screen.getByRole("button", { name: /view maintainers/i }))
    expect(onView).toHaveBeenCalledOnce()
  })

  it("a card locked as a whole says so once under its heading, and its controls stay quiet", () => {
    const reason = <PermissionLockHint role="Maintainers" linkLabel="View Maintainers" onView={() => {}} />
    render(
      <SettingsGroup label="Import" locked={reason}>
        <SettingsRow label="Exclude front matter" control={<DisabledFieldTooltip disabled tooltip={reason}><Switch disabled aria-label="Exclude front matter" /></DisabledFieldTooltip>} />
        <SettingsRow label="Cell unit" control={<DisabledFieldTooltip disabled tooltip={reason}><Button disabled>Sentence</Button></DisabledFieldTooltip>} />
      </SettingsGroup>,
    )
    expect(screen.getByTestId("settings-group-locked")).toHaveTextContent("Only Maintainers can change these settings.")
    expect(screen.queryByText("Only Maintainers can change this.")).toBeNull()
    expect(screen.getAllByRole("button", { name: /view maintainers/i })).toHaveLength(1)
  })

  it("inside a locked card, a control locked for another reason still says its own", () => {
    const shared = <PermissionLockHint role="Maintainers" linkLabel="View Maintainers" onView={() => {}} />
    const lead = <PermissionLockHint role="Project leads" linkLabel="View Project leads" onView={() => {}} />
    render(
      <SettingsGroup label="Text" locked={shared}>
        <SettingsRow label="Minimum role" control={<DisabledFieldTooltip disabled tooltip={shared}><Button disabled>Reviewer</Button></DisabledFieldTooltip>} />
        <SettingsRow label="Count headings" control={<DisabledFieldTooltip disabled tooltip={lead}><Button disabled>Count them</Button></DisabledFieldTooltip>} />
      </SettingsGroup>,
    )
    expect(screen.getByText("Only Maintainers can change these settings.")).toBeVisible()
    expect(screen.getByText("Only Project leads can change this.")).toBeVisible()
  })
})
