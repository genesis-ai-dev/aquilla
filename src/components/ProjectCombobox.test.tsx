// ProjectCombobox — AQU-1518. The upstream-project picker in Create New
// Project used to be a scroll-only dropdown: with a long project list the
// only way to reach a project was to scroll to it. These tests pin the search
// semantics (match anywhere, case-insensitive), the no-matches state, the
// clear row, and that Escape dismisses the list rather than the surface the
// picker sits in — the behaviours a future "simplification" back to a plain
// dropdown would silently lose.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectCombobox, type ProjectComboboxOption } from "./ProjectCombobox"

const OPTIONS: ProjectComboboxOption[] = [
  { id: "p-1", name: "English Source" },
  { id: "p-2", name: "French Episode 1" },
  { id: "p-3", name: "French Episode 2" },
  { id: "p-4", name: "Swahili Pilot" },
]

// `combobox` takes its accessible name from a label, never from its own
// contents — the same wiring the Create dialog gives it via FieldLabel.
function renderPicker(overrides: Partial<Parameters<typeof ProjectCombobox>[0]> = {}) {
  const onValueChange = vi.fn()
  render(
    <>
      <label htmlFor="picker">Upstream project</label>
      <ProjectCombobox
        id="picker"
        options={OPTIONS}
        value=""
        onValueChange={onValueChange}
        placeholder="Choose a project to link from…"
        searchPlaceholder="Search projects…"
        searchAriaLabel="Search projects"
        emptyText="No projects match."
        {...overrides}
      />
    </>,
  )
  return { onValueChange }
}

const trigger = () => screen.getByRole("combobox", { name: "Upstream project" })

const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(trigger())
  return await screen.findByRole("combobox", { name: "Search projects" })
}

describe("ProjectCombobox", () => {
  it("browsing with no query lists every project", async () => {
    const user = userEvent.setup()
    renderPicker()
    await openPicker(user)
    for (const option of OPTIONS) {
      expect(await screen.findByRole("option", { name: option.name })).toBeInTheDocument()
    }
  })

  it("matches a fragment anywhere in the name, not just the start", async () => {
    const user = userEvent.setup()
    renderPicker()
    const search = await openPicker(user)
    await user.type(search, "Episode")
    expect(await screen.findByRole("option", { name: "French Episode 1" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "French Episode 2" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "English Source" })).not.toBeInTheDocument()
  })

  it("matches case-insensitively", async () => {
    const user = userEvent.setup()
    renderPicker()
    const search = await openPicker(user)
    await user.type(search, "sWaHiLi")
    expect(await screen.findByRole("option", { name: "Swahili Pilot" })).toBeInTheDocument()
  })

  it("shows the no-matches state, and deleting the text restores the full list", async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker()
    const search = await openPicker(user)
    await user.type(search, "zzzz")
    expect(await screen.findByText("No projects match.")).toBeInTheDocument()
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    // A query that matches nothing must not have selected anything either.
    expect(onValueChange).not.toHaveBeenCalled()
    await user.clear(search)
    expect(await screen.findByRole("option", { name: "English Source" })).toBeInTheDocument()
  })

  it("reports the id of a project picked out of a filtered list", async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker()
    const search = await openPicker(user)
    await user.type(search, "Pilot")
    await user.click(await screen.findByRole("option", { name: "Swahili Pilot" }))
    expect(onValueChange).toHaveBeenCalledWith("p-4")
  })

  it("picks the highlighted match on Enter, so search works without the mouse", async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker()
    const search = await openPicker(user)
    await user.type(search, "Swa")
    expect(await screen.findByRole("option", { name: "Swahili Pilot" })).toBeInTheDocument()
    await user.keyboard("{ArrowDown}{Enter}")
    expect(onValueChange).toHaveBeenCalledWith("p-4")
  })

  it("shows the chosen project's name on the trigger, never its id", () => {
    renderPicker({ value: "p-2" })
    expect(trigger().textContent).toMatch(/French Episode 1/)
    expect(trigger().textContent).not.toMatch(/p-2/)
  })

  it("a selection can be cleared back to the empty state", async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker({ value: "p-2", clearText: "No upstream project" })
    await user.click(trigger())
    await user.click(await screen.findByTestId("project-option-none"))
    expect(onValueChange).toHaveBeenCalledWith("")
  })

  it("offers the clear row only while something is selected, and never as a search result", async () => {
    const user = userEvent.setup()
    renderPicker({ clearText: "No upstream project" })
    const search = await openPicker(user)
    expect(screen.queryByTestId("project-option-none")).not.toBeInTheDocument()
    await user.type(search, "No upstream")
    expect(await screen.findByText("No projects match.")).toBeInTheDocument()
  })

  it("Escape closes the list without clearing what is already chosen", async () => {
    const user = userEvent.setup()
    const { onValueChange } = renderPicker({ value: "p-2" })
    await user.click(trigger())
    expect(await screen.findByRole("option", { name: "English Source" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    expect(onValueChange).not.toHaveBeenCalled()
    expect(trigger().textContent).toMatch(/French Episode 1/)
  })

  it("reopening starts from a browsable list — the previous query does not persist", async () => {
    const user = userEvent.setup()
    renderPicker()
    const search = await openPicker(user)
    await user.type(search, "Pilot")
    expect(screen.queryByRole("option", { name: "English Source" })).not.toBeInTheDocument()
    await user.keyboard("{Escape}")
    await openPicker(user)
    expect(await screen.findByRole("option", { name: "English Source" })).toBeInTheDocument()
  })
})
