import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { Checkbox } from "./checkbox"
import { Field, FieldLabel } from "./field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"
import { Switch } from "./switch"
import { Button } from "./button"

function selectOpen(): boolean {
  return screen.getByRole("combobox", { name: "Sort" }).getAttribute("aria-expanded") === "true"
}

describe("Label click vs popup controls", () => {
  it("does not open a Select from its FieldLabel", async () => {
    const user = userEvent.setup()
    render(
      <Field>
        <FieldLabel htmlFor="sort">Sort</FieldLabel>
        <Select defaultValue="newest">
          <SelectTrigger id="sort" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="newest">Newest</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>,
    )

    await user.click(screen.getByText("Sort"))
    expect(selectOpen()).toBe(false)
    expect(document.querySelector("[data-slot=select-content]")).toBeNull()

    await user.click(screen.getByRole("combobox", { name: "Sort" }))
    expect(selectOpen()).toBe(true)
  })

  it("does not open a popover from its FieldLabel", async () => {
    const user = userEvent.setup()
    render(
      <Field>
        <FieldLabel htmlFor="filters">Filters</FieldLabel>
        <Popover>
          <PopoverTrigger
            render={
              <Button id="filters" variant="outline" aria-label="Filters">
                Open
              </Button>
            }
          />
          <PopoverContent>Inside</PopoverContent>
        </Popover>
      </Field>,
    )

    await user.click(screen.getByText("Filters"))
    expect(screen.getByRole("button", { name: "Filters" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    expect(screen.queryByText("Inside")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Filters" }))
    expect(screen.getByText("Inside")).toBeInTheDocument()
  })

  it("still toggles a checkbox from its FieldLabel", async () => {
    const user = userEvent.setup()
    render(
      <Field orientation="horizontal">
        <FieldLabel htmlFor="agree">Agree</FieldLabel>
        <Checkbox id="agree" aria-label="Agree" />
      </Field>,
    )

    const checkbox = screen.getByRole("checkbox", { name: "Agree" })
    expect(checkbox).not.toBeChecked()
    await user.click(screen.getByText("Agree"))
    expect(checkbox).toBeChecked()
  })

  it("still toggles a switch from its FieldLabel", async () => {
    const user = userEvent.setup()
    render(
      <Field orientation="horizontal">
        <FieldLabel htmlFor="resolved">Show resolved</FieldLabel>
        <Switch id="resolved" aria-label="Show resolved" />
      </Field>,
    )

    const control = screen.getByRole("switch", { name: "Show resolved" })
    expect(control).not.toBeChecked()
    await user.click(screen.getByText("Show resolved"))
    expect(control).toBeChecked()
  })

  it("still focuses a text input from its FieldLabel", async () => {
    const user = userEvent.setup()
    render(
      <Field>
        <FieldLabel htmlFor="name">Name</FieldLabel>
        <input id="name" aria-label="Name" />
      </Field>,
    )

    await user.click(screen.getByText("Name"))
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus()
  })
})
