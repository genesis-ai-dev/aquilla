/**
 * DocumentGenres — per-file genre assignment on the Translation quality pane
 * (AQU-934 phase 3b).
 *
 * The component is presentational, so nothing is mocked but the suggester the
 * parent injects: these tests are about what each affordance saves (and what it
 * refuses to save without a human confirming it), plus the role gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { FileGenre } from "@/lib/rules/file-genre"
import { DocumentGenres, type GenreFile } from "./DocumentGenres"

const onSave = vi.fn()
const onSuggest = vi.fn<(files: readonly GenreFile[]) => Promise<Record<string, FileGenre>>>()

const FILES: GenreFile[] = [
  { id: "f-psa", name: "Psalms", bookCode: "PSA" },
  { id: "f-rom", name: "Romans", bookCode: "ROM" },
  { id: "f-notes", name: "Leader notes" },
]

function renderSection(overrides: Partial<Parameters<typeof DocumentGenres>[0]> = {}) {
  return render(
    <DocumentGenres
      files={FILES}
      assignments={undefined}
      canEdit
      reasonCannotEdit={null}
      onSave={onSave}
      onSuggest={onSuggest}
      {...overrides}
    />,
  )
}

/** Base UI commits a Select option on Enter after it is pointed at. */
async function chooseGenre(triggerName: string, optionName: string) {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }))
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

/** The row <li> a given file name sits in. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li")
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  onSuggest.mockResolvedValue({})
})

// ── Reading the current state ──────────────────────────────────────────────

describe("DocumentGenres — derived vs assigned", () => {
  it("labels a derived genre, an assigned one, and a file with neither", () => {
    renderSection({ assignments: { "f-rom": "teaching" } })

    // Psalms derives poetry from its book code…
    expect(within(rowFor("Psalms")).getByText("From the book")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Genre for Psalms" })).toHaveTextContent("Poetry")

    // …Romans is overridden by a person (epistle → teaching)…
    expect(within(rowFor("Romans")).getByText("Set by a person")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Genre for Romans" })).toHaveTextContent(
      "Teaching",
    )

    // …and a non-scripture file with no assignment has no genre at all.
    expect(within(rowFor("Leader notes")).getByText("Unclassified")).toBeInTheDocument()
  })

  it("ignores an unknown stored genre and shows the derived value", () => {
    renderSection({ assignments: { "f-psa": "hagiography" } })

    expect(within(rowFor("Psalms")).getByText("From the book")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Genre for Psalms" })).toHaveTextContent("Poetry")
  })

  it("shows an empty state when the project has no files", () => {
    renderSection({ files: [] })
    expect(screen.getByText("No documents in this project yet.")).toBeInTheDocument()
  })
})

// ── Writing ────────────────────────────────────────────────────────────────

describe("DocumentGenres — assigning and resetting", () => {
  it("saves the full map with the newly assigned file", async () => {
    renderSection({ assignments: { "f-rom": "teaching" } })

    await chooseGenre("Genre for Leader notes", "Reference")

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ "f-rom": "teaching", "f-notes": "reference" }),
    )
  })

  it("overrides a derived scripture genre", async () => {
    renderSection()

    await chooseGenre("Genre for Psalms", "Wisdom")

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ "f-psa": "wisdom" }))
  })

  it("drops the key when an assignment is reset back to derived", () => {
    renderSection({ assignments: { "f-psa": "wisdom", "f-rom": "teaching" } })

    fireEvent.click(screen.getByRole("button", { name: "Clear the genre assigned to Psalms" }))

    expect(onSave).toHaveBeenCalledWith({ "f-rom": "teaching" })
  })

  it("offers no reset on a file that has nothing assigned", () => {
    renderSection({ assignments: { "f-psa": "wisdom" } })

    expect(
      screen.getByRole("button", { name: "Clear the genre assigned to Romans" }),
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Clear the genre assigned to Psalms" }),
    ).toBeEnabled()
  })
})

// ── Suggestions ────────────────────────────────────────────────────────────

describe("DocumentGenres — suggestions", () => {
  it("classifies only the files with no explicit assignment", async () => {
    renderSection({ assignments: { "f-psa": "wisdom" } })

    fireEvent.click(screen.getByRole("button", { name: /Suggest genres/ }))

    await waitFor(() => expect(onSuggest).toHaveBeenCalled())
    expect(onSuggest.mock.calls[0][0].map((f) => f.id)).toEqual(["f-rom", "f-notes"])
  })

  it("shows the result for confirmation and saves nothing until confirmed", async () => {
    onSuggest.mockResolvedValue({ "f-notes": "teaching" })
    renderSection()

    fireEvent.click(screen.getByRole("button", { name: /Suggest genres/ }))

    expect(await screen.findByText("Suggested genres")).toBeInTheDocument()
    expect(screen.getByText("Nothing is saved until you confirm these.")).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith({ "f-notes": "teaching" })
  })

  it("merges confirmed suggestions over the existing assignments", async () => {
    onSuggest.mockResolvedValue({ "f-notes": "reference" })
    renderSection({ assignments: { "f-psa": "wisdom" } })

    fireEvent.click(screen.getByRole("button", { name: /Suggest genres/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Save" }))

    expect(onSave).toHaveBeenCalledWith({ "f-psa": "wisdom", "f-notes": "reference" })
  })

  it("discards the result without saving", async () => {
    onSuggest.mockResolvedValue({ "f-notes": "teaching" })
    renderSection()

    fireEvent.click(screen.getByRole("button", { name: /Suggest genres/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByText("Suggested genres")).not.toBeInTheDocument()
  })

  it("says so when the run classifies nothing", async () => {
    onSuggest.mockResolvedValue({})
    renderSection()

    fireEvent.click(screen.getByRole("button", { name: /Suggest genres/ }))

    expect(
      await screen.findByText("No genres suggested. Assign them by hand instead."),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  })

  it("surfaces a failed run", async () => {
    onSuggest.mockRejectedValue(new Error("model unavailable"))
    renderSection()

    fireEvent.click(screen.getByRole("button", { name: /Suggest genres/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't suggest genres: model unavailable",
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it("explains the missing model instead of offering the action", () => {
    renderSection({ onSuggest: undefined })

    expect(screen.queryByRole("button", { name: /Suggest genres/ })).not.toBeInTheDocument()
    expect(
      screen.getByText("Set up an AI model for this project before suggesting genres."),
    ).toBeInTheDocument()
  })
})

// ── Role gate ──────────────────────────────────────────────────────────────

describe("DocumentGenres — role gate", () => {
  it("locks every write below the settings floor", () => {
    renderSection({ canEdit: false, reasonCannotEdit: "role", assignments: { "f-psa": "wisdom" } })

    expect(screen.queryByRole("button", { name: /Suggest genres/ })).not.toBeInTheDocument()
    expect(screen.getAllByLabelText(/requires Maintainer role/i).length).toBeGreaterThan(0)
    expect(screen.getByRole("combobox", { name: "Genre for Psalms" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Clear the genre assigned to Psalms" }),
    ).toBeDisabled()
    // The state itself stays readable — only the controls are locked.
    expect(within(rowFor("Psalms")).getByText("Set by a person")).toBeInTheDocument()
  })

  it("names the offline reason when that is what blocks the write", () => {
    renderSection({ canEdit: false, reasonCannotEdit: "offline" })
    expect(screen.getAllByLabelText(/offline/i).length).toBeGreaterThan(0)
  })
})
