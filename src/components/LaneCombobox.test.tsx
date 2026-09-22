// LaneCombobox — the one lane picker every surface routes through (AQU-609).
// WHY: client projects carry 150+ lanes and lane switching is a combobox by
// explicit client request; these tests pin the search + archived (AQU-601)
// semantics so no surface quietly regresses to an unsearchable or
// archive-blind picker.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LaneCombobox, type LaneComboboxOption } from "./LaneCombobox"

const OPTIONS: LaneComboboxOption[] = [
  { value: "", label: "Spanish (default)", testId: "" },
  { value: "fr", label: "fr", testId: "fr" },
  { value: "pt-BR", label: "pt-BR", testId: "pt-BR" },
  { value: "sw", label: "sw", archived: true, testId: "sw" },
]

function renderPicker(overrides: Partial<Parameters<typeof LaneCombobox>[0]> = {}) {
  const onValueChange = vi.fn()
  render(
    <LaneCombobox
      options={OPTIONS}
      value=""
      onValueChange={onValueChange}
      searchPlaceholder="Search lanes…"
      searchAriaLabel="Search lanes"
      emptyText="No lanes found."
      trigger={<button type="button" aria-label="Lane">Lane</button>}
      {...overrides}
    />,
  )
  return { onValueChange }
}

describe("LaneCombobox", () => {
  it("selects a lane and reports its value", async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker()
    await user.click(screen.getByRole("combobox", { name: "Lane" }))
    await user.click(await screen.findByRole("option", { name: "fr" }))
    expect(onValueChange).toHaveBeenCalledWith("fr")
  })

  it("hides archived lanes behind the reveal row while browsing (AQU-601)", async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole("combobox", { name: "Lane" }))
    expect(await screen.findByRole("option", { name: "fr" })).toBeInTheDocument()
    expect(screen.queryByTestId("lane-option-sw")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("lane-show-archived"))
    expect(await screen.findByTestId("lane-option-sw")).toBeInTheDocument()
    // Revealing must not have closed the popup or selected anything.
    expect(screen.getByRole("option", { name: "fr" })).toBeInTheDocument()
  })

  it("search matches archived lanes without a reveal — expand-then-scan is not navigation", async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker()
    await user.click(screen.getByRole("combobox", { name: "Lane" }))
    await user.type(screen.getByRole("combobox", { name: "Search lanes" }), "sw")
    const archived = await screen.findByTestId("lane-option-sw")
    expect(archived).toHaveAttribute("data-archived", "true")
    await user.click(archived)
    expect(onValueChange).toHaveBeenCalledWith("sw")
  })

  it("search filters the list and shows the empty state on no match", async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole("combobox", { name: "Lane" }))
    await user.type(screen.getByRole("combobox", { name: "Search lanes" }), "pt")
    expect(await screen.findByRole("option", { name: "pt-BR" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "fr" })).not.toBeInTheDocument()
    await user.clear(screen.getByRole("combobox", { name: "Search lanes" }))
    await user.type(screen.getByRole("combobox", { name: "Search lanes" }), "zzz")
    expect(await screen.findByText("No lanes found.")).toBeInTheDocument()
  })

  it("an archived active selection is visible without a manual reveal", async () => {
    const user = userEvent.setup()
    renderPicker({ value: "sw" })
    await user.click(screen.getByRole("combobox", { name: "Lane" }))
    expect(await screen.findByTestId("lane-option-sw")).toHaveAttribute("data-active", "true")
    // Auto-reveal replaces the reveal row entirely.
    expect(screen.queryByTestId("lane-show-archived")).not.toBeInTheDocument()
  })

  it("footer action runs and closes the popup without selecting", async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const { onValueChange } = renderPicker({
      footer: (close) => (
        <button
          type="button"
          data-testid="edit-target-language"
          onClick={() => {
            close()
            onEdit()
          }}
        >
          Change target language…
        </button>
      ),
    })
    await user.click(screen.getByRole("combobox", { name: "Lane" }))
    await user.click(await screen.findByTestId("edit-target-language"))
    expect(onEdit).toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
