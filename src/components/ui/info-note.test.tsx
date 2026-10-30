// AQU-2260 (Sam, Oct 29): explanations open on click, never on hover. InfoNote
// is an (i) with an anchored note; NoteOnClick makes a badge or status mark
// its own button.
import { describe, expect, it } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InfoNote, NoteOnClick } from "./info-note"

describe("InfoNote", () => {
  it("opens its note on click, shows nothing on hover, and shuts on a second click", async () => {
    render(<InfoNote label="About timing">Lines follow the film.</InfoNote>)
    const info = screen.getByRole("button", { name: "About timing" })
    await userEvent.setup().hover(info)
    expect(screen.queryByText("Lines follow the film.")).toBeNull()
    fireEvent.click(info)
    expect(await screen.findByText("Lines follow the film.")).toBeVisible()
    fireEvent.click(info)
    await waitFor(() => expect(screen.queryByText("Lines follow the film.")).toBeNull())
  })
})

describe("NoteOnClick", () => {
  it("makes the mark a button that opens its note on click", async () => {
    render(<NoteOnClick note="Waiting for the model.">Waiting</NoteOnClick>)
    const mark = screen.getByRole("button", { name: "Waiting" })
    await userEvent.setup().hover(mark)
    expect(screen.queryByText("Waiting for the model.")).toBeNull()
    fireEvent.click(mark)
    expect(await screen.findByText("Waiting for the model.")).toBeVisible()
  })

  it("adds no Tab stop for a mark repeated on every row, though a click still opens it", async () => {
    render(<NoteOnClick note="No audio to validate." tabStop={false}><span>·</span></NoteOnClick>)
    const mark = screen.getByRole("button")
    expect(mark).toHaveAttribute("tabindex", "-1")
    fireEvent.click(mark)
    expect(await screen.findByText("No audio to validate.")).toBeVisible()
  })

  it("is just the mark when there is nothing to say", () => {
    render(<NoteOnClick note={null}><span>Plain</span></NoteOnClick>)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Plain")).toBeInTheDocument()
  })
})
