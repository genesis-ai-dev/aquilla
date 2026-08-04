import { useState } from "react"
import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import {
  MultiSelectCombobox,
  MultiSelectComboboxContent,
  MultiSelectComboboxEmpty,
  MultiSelectComboboxList,
  MultiSelectComboboxOption,
  MultiSelectComboboxSearch,
  MultiSelectComboboxTrigger,
  MultiSelectComboboxValue,
} from "./multi-select-combobox"

const ITEMS = ["apples", "bananas", "cherries"]

/** Plain-string harness — no avatars, so this covers the generic surface. */
function Harness({
  initial = [],
  onValueChange,
  onKeyDownCapture,
}: {
  initial?: string[]
  onValueChange?: (next: string[]) => void
  onKeyDownCapture?: (event: React.KeyboardEvent) => void
}) {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <MultiSelectCombobox
      items={ITEMS}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onValueChange?.(next)
      }}
    >
      <MultiSelectComboboxTrigger aria-label="Fruit">
        <MultiSelectComboboxValue placeholder="Pick fruit…" />
      </MultiSelectComboboxTrigger>
      <MultiSelectComboboxContent onKeyDownCapture={onKeyDownCapture}>
        <MultiSelectComboboxSearch placeholder="Search fruit…" aria-label="Search fruit" />
        <MultiSelectComboboxEmpty>No fruit found.</MultiSelectComboboxEmpty>
        <MultiSelectComboboxList>
          {(item: string) => (
            <MultiSelectComboboxOption key={item} value={item}>
              <span className="flex-1">{item}</span>
            </MultiSelectComboboxOption>
          )}
        </MultiSelectComboboxList>
      </MultiSelectComboboxContent>
    </MultiSelectCombobox>
  )
}

function trigger() {
  return screen.getByRole("combobox", { name: "Fruit" })
}

describe("MultiSelectCombobox", () => {
  it("shows the placeholder while empty", () => {
    render(<Harness />)
    expect(trigger().textContent).toContain("Pick fruit…")
  })

  it("joins selected values comma-separated when no value renderer is given", () => {
    render(<Harness initial={["apples", "cherries"]} />)
    expect(trigger().textContent).toContain("apples, cherries")
    expect(screen.queryByText("Pick fruit…")).toBeNull()
  })

  it("toggles selection from checkbox rows without closing the popup", async () => {
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)

    fireEvent.click(trigger())
    const option = await screen.findByRole("option", { name: "bananas" })
    expect(option.querySelector('[data-slot="checkbox"]')?.getAttribute("aria-checked")).toBe(
      "false",
    )

    fireEvent.click(option)
    expect(onValueChange).toHaveBeenCalledWith(["bananas"])
    const reselected = await screen.findByRole("option", { name: "bananas" })
    expect(
      reselected.querySelector('[data-slot="checkbox"]')?.getAttribute("aria-checked"),
    ).toBe("true")

    fireEvent.click(reselected)
    expect(onValueChange).toHaveBeenLastCalledWith([])
  })

  it("Enter toggles the highlighted option and closes; Shift+Enter keeps it open", async () => {
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)

    fireEvent.click(trigger())
    const search = await screen.findByRole("combobox", { name: "Search fruit" })
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true })
    expect(onValueChange).toHaveBeenCalledWith(["apples"])
    expect(screen.getByRole("combobox", { name: "Search fruit" })).toBeTruthy()

    fireEvent.keyDown(search, { key: "Enter" })
    expect(onValueChange).toHaveBeenLastCalledWith([])
    expect(screen.queryByRole("combobox", { name: "Search fruit" })).toBeNull()
  })

  it("Space selects on an empty query and after ArrowDown, but types mid-query", async () => {
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)

    fireEvent.click(trigger())
    const search = await screen.findByRole("combobox", { name: "Search fruit" })

    // Empty query → Space selects the auto-highlighted first option.
    expect(fireEvent.keyDown(search, { key: " " })).toBe(false)
    expect(onValueChange).toHaveBeenCalledWith(["apples"])
    onValueChange.mockClear()

    // Mid-query → Space belongs to the search field.
    fireEvent.change(search, { target: { value: "ban" } })
    expect(fireEvent.keyDown(search, { key: " " })).toBe(true)
    expect(onValueChange).not.toHaveBeenCalled()

    // ArrowDown locks list navigation → Space selects again.
    fireEvent.keyDown(search, { key: "ArrowDown" })
    expect(fireEvent.keyDown(search, { key: " " })).toBe(false)
    expect(onValueChange).toHaveBeenCalled()
  })

  it("lets a caller's onKeyDownCapture run first and pre-empt the built-in keys", async () => {
    const onValueChange = vi.fn()
    const onKeyDownCapture = vi.fn((event: React.KeyboardEvent) => {
      if (event.key === "Enter") event.preventDefault()
    })
    render(<Harness onValueChange={onValueChange} onKeyDownCapture={onKeyDownCapture} />)

    fireEvent.click(trigger())
    const search = await screen.findByRole("combobox", { name: "Search fruit" })
    fireEvent.keyDown(search, { key: "Enter" })

    expect(onKeyDownCapture).toHaveBeenCalled()
    // The built-in Enter toggle is skipped; what Base UI does with the
    // already-prevented event is its own business.
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it("renders the empty state when nothing matches the query", async () => {
    render(<Harness />)

    fireEvent.click(trigger())
    const search = await screen.findByRole("combobox", { name: "Search fruit" })
    fireEvent.change(search, { target: { value: "zzz" } })

    expect(await screen.findByText("No fruit found.")).toBeTruthy()
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })

  it("throws when a part is rendered outside the root", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() =>
      render(
        <MultiSelectComboboxTrigger aria-label="Orphan">
          <span>orphan</span>
        </MultiSelectComboboxTrigger>,
      ),
    ).toThrow(/inside <MultiSelectCombobox>/)
    error.mockRestore()
  })
})
