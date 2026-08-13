import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { RoleSelect } from "./RoleSelect"
import { ALL_ROLE_OPTIONS, LINK_ROLE_OPTIONS, roleDescription } from "@/lib/frontier/roles"

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Base UI Select: click does not commit under happy-dom — highlight + Enter. */
async function pickRoleOption(optionName: RegExp) {
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

describe("RoleSelect", () => {
  it("lists each role with its capability description in the dropdown", async () => {
    const onValueChange = vi.fn()
    render(
      <RoleSelect
        options={LINK_ROLE_OPTIONS}
        value={400}
        onValueChange={onValueChange}
        aria-label="Role"
      />,
    )

    const trigger = screen.getByRole("combobox", { name: "Role" })
    expect(trigger).toHaveTextContent(/contributor/i)

    fireEvent.click(trigger)

    const listbox = await screen.findByRole("listbox")
    for (const opt of LINK_ROLE_OPTIONS) {
      // Match by description — "viewer" is a substring of "reviewer".
      const option = within(listbox).getByRole("option", {
        name: new RegExp(escapeRegExp(roleDescription(opt.level))),
      })
      expect(option).toHaveTextContent(new RegExp(opt.name, "i"))
    }

    await pickRoleOption(new RegExp(escapeRegExp(roleDescription(100))))
    expect(onValueChange).toHaveBeenCalledWith(100)
  })

  it("defaults to the full role ladder", async () => {
    render(
      <RoleSelect value={100} onValueChange={() => {}} aria-label="Role" />,
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Role" }))
    const listbox = await screen.findByRole("listbox")
    expect(within(listbox).getAllByRole("option")).toHaveLength(ALL_ROLE_OPTIONS.length)
    expect(
      within(listbox).getByRole("option", {
        name: new RegExp(escapeRegExp(roleDescription(700))),
      }),
    ).toBeInTheDocument()
  })
})
