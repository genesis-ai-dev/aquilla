// AQU-1044 — the combined Sort by menu for the org Projects toolbar: one
// trigger, one submenu per dimension (Status, PM, Role, Updated) with radio
// options inside, an active-count badge on the trigger, and the picked value
// echoed on its submenu row. The narrowing semantics themselves are covered
// by the OrgProjectsPage.{pm,role,updated}-filter page tests and the pure
// project-*-filter module tests — this file covers only the menu chrome.

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { ProjectSortMenu } from "./ProjectSortMenu"
import { PM_FILTER_ALL, pmFilterFor } from "./project-pm-filter"
import { ROLE_FILTER_ALL, roleFilterFor } from "./project-role-filter"
import { UPDATED_FILTER_ANY, updatedFilterFor } from "./project-updated-filter"

function renderMenu(overrides: Partial<ComponentProps<typeof ProjectSortMenu>> = {}) {
  const props: ComponentProps<typeof ProjectSortMenu> = {
    status: "all",
    onStatusChange: vi.fn(),
    pm: PM_FILTER_ALL,
    pmUsernames: ["anna", "mark"],
    showUnassignedPm: true,
    onPmChange: vi.fn(),
    role: ROLE_FILTER_ALL,
    roleNames: ["contributor", "owner"],
    onRoleChange: vi.fn(),
    updated: UPDATED_FILTER_ANY,
    onUpdatedChange: vi.fn(),
    ...overrides,
  }
  render(<ProjectSortMenu {...props} />)
  return props
}

describe("ProjectSortMenu (AQU-1044)", () => {
  it("shows one Sort by trigger opening a submenu per dimension", async () => {
    renderMenu()

    const trigger = screen.getByTestId("project-sort-menu")
    expect(trigger).toHaveTextContent("Sort by")
    fireEvent.click(trigger)

    const submenus = (await screen.findAllByRole("menuitem")).map((el) => el.textContent)
    expect(submenus).toEqual(["Status", "PM", "Role", "Updated"])
  })

  it("reports a picked radio option as the dimension's typed value", async () => {
    const props = renderMenu()

    fireEvent.click(screen.getByTestId("project-sort-menu"))
    fireEvent.click(await screen.findByRole("menuitem", { name: /^pm/i }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "anna" }))
    expect(props.onPmChange).toHaveBeenCalledWith(pmFilterFor("anna"))

    fireEvent.click(await screen.findByRole("menuitem", { name: /^status/i }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Stalled" }))
    expect(props.onStatusChange).toHaveBeenCalledWith("stalled")
  })

  it("tallies non-default dimensions on the trigger and echoes each picked value", async () => {
    renderMenu({
      pm: pmFilterFor("anna"),
      role: roleFilterFor("owner"),
      updated: updatedFilterFor(7),
    })

    expect(screen.getByTestId("project-sort-menu-count")).toHaveTextContent("3")

    fireEvent.click(screen.getByTestId("project-sort-menu"))
    const submenus = (await screen.findAllByRole("menuitem")).map((el) => el.textContent)
    // The default dimension (Status) shows no echo; the active three do.
    expect(submenus).toEqual([
      "Status",
      "PManna",
      "RoleOwner",
      "UpdatedUpdated in last 7 days",
    ])
  })

  it("shows no badge and no echoes when every dimension is at its default", async () => {
    renderMenu()

    expect(screen.queryByTestId("project-sort-menu-count")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("project-sort-menu"))
    fireEvent.click(await screen.findByRole("menuitem", { name: /^role/i }))
    const options = await screen.findAllByRole("menuitemradio")
    expect(options.map((el) => el.textContent)).toEqual(["All roles", "Contributor", "Owner"])
    // The all-roles default is the checked radio.
    expect(options[0]).toHaveAttribute("aria-checked", "true")
  })
})
