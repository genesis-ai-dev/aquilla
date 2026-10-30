// SearchSelect (AQU-2260): the dropdown with a search box for lists that grow
// with your data. Pins what a "simplification" back to a plain Select would
// lose: the box narrows the list anywhere in a name and ignoring case, an
// empty search shows "No matches", the box empties when the list closes, and
// choosing calls back with the option's value.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SearchSelect } from "./search-select"

const BOOKS = [
  { value: "gen", label: "Genesis" },
  { value: "exo", label: "Exodus" },
  { value: "1sa", label: "1 Samuel" },
  { value: "2sa", label: "2 Samuel" },
  { value: "rev", label: "Revelation", keywords: "apocalypse" },
]

function draw(value = "exo") {
  const onValueChange = vi.fn()
  render(
    <>
      <label htmlFor="book">Book</label>
      <SearchSelect id="book" options={BOOKS} value={value} onValueChange={onValueChange} />
    </>,
  )
  return { onValueChange }
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("combobox", { name: "Book" }))
  return await screen.findByRole("combobox", { name: "Search the list" })
}

describe("SearchSelect", () => {
  it("shows the chosen option on its button, like a Select", () => {
    draw()
    expect(screen.getByRole("combobox", { name: "Book" })).toHaveTextContent("Exodus")
  })

  it("opens on the whole list with a search box at the top", async () => {
    const user = userEvent.setup()
    draw()
    const search = await open(user)
    expect(search).toHaveAttribute("placeholder", "Search…")
    for (const b of BOOKS) expect(await screen.findByRole("option", { name: b.label })).toBeInTheDocument()
  })

  it("narrows the list to names containing what is typed, anywhere, ignoring case", async () => {
    const user = userEvent.setup()
    draw()
    await user.type(await open(user), "sAmUeL")
    expect(await screen.findByRole("option", { name: "1 Samuel" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "2 Samuel" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "Genesis" })).not.toBeInTheDocument()
  })

  it("matches the hidden keywords too", async () => {
    const user = userEvent.setup()
    draw()
    await user.type(await open(user), "apoc")
    expect(await screen.findByRole("option", { name: "Revelation" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "Exodus" })).not.toBeInTheDocument()
  })

  it("says No matches when nothing matches", async () => {
    const user = userEvent.setup()
    draw()
    await user.type(await open(user), "zzz")
    expect(await screen.findByText("No matches")).toBeInTheDocument()
  })

  it("calls back with the chosen option's value, from a click or from Enter", async () => {
    const user = userEvent.setup()
    const { onValueChange } = draw()
    await open(user)
    await user.click(await screen.findByRole("option", { name: "Genesis" }))
    expect(onValueChange).toHaveBeenLastCalledWith("gen")
    await user.type(await open(user), "rev{Enter}")
    expect(onValueChange).toHaveBeenLastCalledWith("rev")
  })

  it("reopens on the whole list after a search", async () => {
    const user = userEvent.setup()
    draw()
    await user.type(await open(user), "gen")
    await user.keyboard("{Escape}")
    const search = await open(user)
    expect(search).toHaveValue("")
    expect(await screen.findByRole("option", { name: "Revelation" })).toBeInTheDocument()
  })

  it("shows a list's own nothing-chosen row on the button, greyed", () => {
    render(
      <SearchSelect
        aria-label="Assign to"
        options={[{ value: "", label: "Select member…" }, { value: "7", label: "anna" }]}
        value=""
        onValueChange={() => {}}
      />,
    )
    const button = screen.getByRole("combobox", { name: "Assign to" })
    expect(button).toHaveTextContent("Select member…")
    expect(button.querySelector("[data-slot=select-value]")?.className).toMatch(/text-muted-foreground/)
  })
})
