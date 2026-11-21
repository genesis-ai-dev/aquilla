import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "./combobox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

/**
 * AQU-2707: a dropdown paints no highlight until the keyboard moves it, the
 * same way the notification inbox waits for an arrow key.
 */

function ToolsMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Tools</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Draft</DropdownMenuItem>
        <DropdownMenuItem>Check</DropdownMenuItem>
        <DropdownMenuItem>Export</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function menuPopup() {
  const popup = document.querySelector("[data-slot='dropdown-menu-content']")
  expect(popup).not.toBeNull()
  return popup as HTMLElement
}

function TargetSelect() {
  return (
    <Select defaultValue="es">
      <SelectTrigger aria-label="Target">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="es">es</SelectItem>
        <SelectItem value="fr">fr</SelectItem>
        <SelectItem value="fa">Persian</SelectItem>
      </SelectContent>
    </Select>
  )
}

function LanePicker() {
  return (
    <Combobox items={["es", "fr", "fa"]} defaultValue="es">
      <ComboboxTrigger aria-label="Target language">es</ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput aria-label="Search language lanes" />
        <ComboboxList>
          {(lane: string) => (
            <ComboboxItem key={lane} value={lane}>
              {lane}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

describe("dropdown highlight waits for the keyboard (AQU-2707)", () => {
  it("opens a menu plain, then ArrowDown highlights the first row and ArrowUp the last", async () => {
    const user = userEvent.setup()
    render(<ToolsMenu />)

    await user.click(screen.getByRole("button", { name: "Tools" }))
    const popup = menuPopup()
    expect(popup).toHaveAttribute("data-plain-until-key", "")
    expect(popup.querySelector("[data-highlighted]")).toBeNull()

    await user.hover(screen.getByRole("menuitem", { name: "Draft" }))
    expect(popup.querySelector("[data-highlighted]")).toBeNull()

    await user.keyboard("{ArrowDown}")
    expect(popup).not.toHaveAttribute("data-plain-until-key")
    expect(screen.getByRole("menuitem", { name: "Draft" })).toHaveAttribute("data-highlighted")

    await user.keyboard("{Escape}")
    await user.click(screen.getByRole("button", { name: "Tools" }))
    const reopened = menuPopup()
    expect(reopened).toHaveAttribute("data-plain-until-key", "")
    await user.keyboard("{ArrowUp}")
    expect(screen.getByRole("menuitem", { name: "Export" })).toHaveAttribute("data-highlighted")
  })

  it("shows the highlight immediately when the menu was opened from the keyboard", async () => {
    const user = userEvent.setup()
    render(<ToolsMenu />)
    screen.getByRole("button", { name: "Tools" }).focus()
    await user.keyboard("{ArrowDown}")

    const popup = menuPopup()
    expect(popup).not.toHaveAttribute("data-plain-until-key")
    expect(screen.getByRole("menuitem", { name: "Draft" })).toHaveAttribute("data-highlighted")
  })

  it("keeps a select's chosen row plain until an arrow key, then moves from it", async () => {
    const user = userEvent.setup()
    render(<TargetSelect />)

    await user.click(screen.getByRole("combobox", { name: "Target" }))
    const popup = document.querySelector("[data-slot='select-content']")
    expect(popup).toHaveAttribute("data-plain-until-key", "")

    await user.keyboard("{ArrowDown}")
    expect(popup).not.toHaveAttribute("data-plain-until-key")
    expect(screen.getByRole("option", { name: "fr" })).toHaveAttribute("data-highlighted")
  })

  it("keeps a combobox's chosen lane plain until an arrow key", async () => {
    const user = userEvent.setup()
    render(<LanePicker />)

    await user.click(screen.getByRole("combobox", { name: "Target language" }))
    const popup = document.querySelector("[data-slot='combobox-content']")
    expect(popup).toHaveAttribute("data-plain-until-key", "")

    await user.keyboard("{ArrowDown}")
    expect(popup).not.toHaveAttribute("data-plain-until-key")
    expect(screen.getByRole("option", { name: "fr" })).toHaveAttribute("data-highlighted")
  })
})
