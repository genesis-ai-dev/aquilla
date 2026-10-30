import { render, screen, waitFor } from "@testing-library/react"
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

function SortSelect({
  alignItemWithTrigger,
}: {
  alignItemWithTrigger?: boolean
}) {
  return (
    <Select defaultValue="newest">
      <SelectTrigger aria-label="Sort">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={alignItemWithTrigger}>
        <SelectGroup>
          <SelectItem value="newest">Newest</SelectItem>
          <SelectItem value="oldest">Oldest</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

describe("Select trigger chrome", () => {
  it("keeps the trigger border classes while open", async () => {
    const user = userEvent.setup()
    render(<SortSelect />)

    const trigger = screen.getByRole("combobox", { name: "Sort" })
    expect(trigger.className).toMatch(/border-input/)
    expect(trigger.className).toMatch(/data-popup-open:border-input/)
    expect(trigger.className).toMatch(/text-foreground/)

    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  it("does not keep hover fill classes that apply while a sibling FieldLabel is hovered", () => {
    render(<SortSelect />)
    const trigger = screen.getByRole("combobox", { name: "Sort" })
    expect(trigger.className).toMatch(
      /group-has-\[\[data-slot=field-label\]:hover\]\/field:not-aria-expanded:hover:bg-transparent/,
    )
  })

  it("uses the settings-row hover wash on the closed trigger", async () => {
    const user = userEvent.setup()
    render(<SortSelect />)
    const trigger = screen.getByRole("combobox", { name: "Sort" })
    expect(trigger.className).toMatch(/hover:bg-accent\/40/)
    expect(trigger.className).not.toMatch(/hover:bg-muted/)
    expect(trigger.className).not.toMatch(/active:bg-accent/)
    expect(trigger.className).not.toMatch(/aria-expanded:bg-accent/)
    expect(trigger.className).not.toMatch(/data-popup-open:bg-accent/)
    expect(trigger.className).toMatch(/data-dropdown:bg-accent\/40/)
    expect(trigger.className).not.toMatch(/data-dropdown:bg-accent(?!\/)/)

    await user.click(trigger)
    expect(screen.getByRole("option", { name: "Newest" }).className).toMatch(
      /focus:bg-accent\/40/,
    )
  })

  it("paints the open trigger only when the popup is in dropdown placement", async () => {
    const user = userEvent.setup()
    render(<SortSelect />)
    const trigger = screen.getByRole("combobox", { name: "Sort" })
    expect(trigger).not.toHaveAttribute("data-dropdown")

    await user.click(trigger)
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "true")
      const positioner = document
        .querySelector("[data-slot=select-content]")
        ?.closest("[data-side]")
      expect(positioner).toHaveAttribute("data-side")
      const side = positioner?.getAttribute("data-side")
      if (side === "none") {
        expect(trigger).not.toHaveAttribute("data-dropdown")
      } else {
        expect(trigger).toHaveAttribute("data-dropdown")
      }
    })
  })

  it("paints the open trigger when alignItemWithTrigger is off", async () => {
    const user = userEvent.setup()
    render(<SortSelect alignItemWithTrigger={false} />)
    const trigger = screen.getByRole("combobox", { name: "Sort" })

    await user.click(trigger)
    await waitFor(() => {
      expect(trigger).toHaveAttribute("data-dropdown")
    })
    expect(
      document.querySelector("[data-slot=select-content]")?.closest("[data-side]"),
    ).not.toHaveAttribute("data-side", "none")
  })
})

// AQU-2260 (Sam, Oct 29, Settings cleanup option 2A): every list opens BELOW
// its button — flipping above only when there is no room — and scrolls with a
// normal scrollbar, the wheel and the keys. No ▲ ▼ strips anywhere.
describe("Select list placement (AQU-2260)", () => {
  function LongSelect() {
    const options = Array.from({ length: 30 }, (_, i) => `Option ${i + 1}`)
    return (
      <Select defaultValue="Option 25">
        <SelectTrigger aria-label="Long">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    )
  }

  it("opens below its button by default, not laid over it", async () => {
    const user = userEvent.setup()
    render(<SortSelect />)
    const trigger = screen.getByRole("combobox", { name: "Sort" })
    await user.click(trigger)
    await waitFor(() => {
      const popup = document.querySelector("[data-slot=select-content]")
      expect(popup).not.toBeNull()
      expect(popup).toHaveAttribute("data-align-trigger", "false")
      expect(popup?.closest("[data-side]")).not.toHaveAttribute("data-side", "none")
      expect(trigger).toHaveAttribute("data-dropdown")
    })
  })

  it("draws no scroll strips, even for a long list whose choice is far down", async () => {
    const user = userEvent.setup()
    render(<LongSelect />)
    await user.click(screen.getByRole("combobox", { name: "Long" }))
    await waitFor(() => expect(document.querySelector("[data-slot=select-content]")).not.toBeNull())
    expect(document.querySelector("[data-slot=select-scroll-up-button]")).toBeNull()
    expect(document.querySelector("[data-slot=select-scroll-down-button]")).toBeNull()
    // The list itself is the scroller: a normal scrollbar, not a hover strip.
    expect(document.querySelector("[data-slot=select-content]")?.className).toMatch(/overflow-y-auto/)
  })
})
