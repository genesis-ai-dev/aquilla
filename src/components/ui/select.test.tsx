import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

describe("Select trigger chrome", () => {
  it("keeps the trigger border classes while open", async () => {
    const user = userEvent.setup()
    render(
      <Select defaultValue="newest">
        <SelectTrigger aria-label="Sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="oldest">Oldest</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    )

    const trigger = screen.getByRole("combobox", { name: "Sort" })
    expect(trigger.className).toMatch(/border-input/)
    expect(trigger.className).toMatch(/data-popup-open:border-input/)
    expect(trigger.className).toMatch(/text-foreground/)

    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  it("does not keep hover fill classes that apply while a sibling FieldLabel is hovered", () => {
    render(
      <Select defaultValue="newest">
        <SelectTrigger aria-label="Sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="newest">Newest</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    )
    const trigger = screen.getByRole("combobox", { name: "Sort" })
    expect(trigger.className).toMatch(
      /group-has-\[\[data-slot=field-label\]:hover\]\/field:not-aria-expanded:hover:bg-transparent/,
    )
  })
})
