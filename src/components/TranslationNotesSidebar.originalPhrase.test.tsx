// AQU-527 — the note's original-language phrase reaches the screen.
//
// WHY at this level: the phrase travels cell metadata → `readNoteReferenceMetadata`
// → this panel, and every earlier link was already green while the panel showed
// prose alone (the metadata bucket was simply never read). So the regression that
// escaped is "the note renders without its quote", and that is only observable
// here, against a cell row shaped the way the read route actually returns one.
//
// The quotes are real unfoldingWord data for MAT 2:1 and GEN 1:1 — a Greek and a
// Hebrew phrase, accents and cantillation intact, because the direction and font
// hints are derived from those characters.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

const fetchProjectFiles = vi.fn()
const fetchFileCells = vi.fn()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: (...args: unknown[]) => fetchProjectFiles(...args),
  fetchFileCells: (...args: unknown[]) => fetchFileCells(...args),
}))

import { TranslationNotesSidebar } from "./TranslationNotesSidebar"

const GREEK_QUOTE = "Βηθλέεμ τῆς Ἰουδαίας"
const HEBREW_QUOTE = "בְּ⁠רֵאשִׁ֖ית"
const NOTE_BODY = "Here, Matthew is using the possessive form."

/** One source cell as the cells-read route returns it, notes-file flavoured. */
function noteCell(value: string, metadata: Record<string, unknown> | null) {
  return { cellId: "c1", side: "source", value, canonicalRef: "GEN 1:1", metadata }
}

function renderSidebar() {
  return render(
    <TranslationNotesSidebar
      projectId="proj-1"
      canonicalRef="GEN 1:1"
      getToken={async () => "tok"}
      visible={true}
      onToggle={() => {}}
    />,
  )
}

describe("TranslationNotesSidebar original-language phrase (AQU-527)", () => {
  beforeEach(() => {
    fetchProjectFiles.mockReset()
    fetchFileCells.mockReset()
    fetchProjectFiles.mockResolvedValue([
      { fileId: "tn-1", name: "tn_GEN.tsv", fileType: "tsv" },
    ])
  })

  it("shows the Greek phrase the note is about, alongside the note prose", async () => {
    fetchFileCells.mockResolvedValue({
      cells: [noteCell(NOTE_BODY, { quote: GREEK_QUOTE, occurrence: "1" })],
      nextCursor: undefined,
    })
    renderSidebar()

    await waitFor(() => expect(screen.getByText(NOTE_BODY)).toBeTruthy())
    const phrase = screen.getByText(GREEK_QUOTE)
    // Ancient Greek, so a script-appropriate font is picked and a screen reader
    // voices it as Greek rather than spelling it out in the UI language.
    expect(phrase.getAttribute("lang")).toBe("grc")
    expect(phrase.getAttribute("dir")).toBe("auto")
  })

  it("lets a Hebrew phrase set its own direction inside the left-to-right panel", async () => {
    fetchFileCells.mockResolvedValue({
      cells: [noteCell(NOTE_BODY, { quote: HEBREW_QUOTE })],
      nextCursor: undefined,
    })
    renderSidebar()

    const phrase = await waitFor(() => screen.getByText(HEBREW_QUOTE))
    expect(phrase.getAttribute("lang")).toBe("he")
    // `dir="auto"` rather than a hard "rtl": the same element renders Greek.
    expect(phrase.getAttribute("dir")).toBe("auto")
    // The announced label sits outside that element — an English span in front
    // of the quote would make the first strong character Latin and flip it.
    expect(phrase.textContent).toBe(HEBREW_QUOTE)
  })

  it("reads the legacy `origQuote` key an older importer wrote", async () => {
    fetchFileCells.mockResolvedValue({
      cells: [noteCell(NOTE_BODY, { origQuote: GREEK_QUOTE })],
      nextCursor: undefined,
    })
    renderSidebar()
    await waitFor(() => expect(screen.getByText(GREEK_QUOTE)).toBeTruthy())
  })

  it("marks which occurrence a note addresses only when it is not the first", async () => {
    fetchFileCells.mockResolvedValue({
      cells: [
        noteCell("First note.", { quote: GREEK_QUOTE, occurrence: "1" }),
        noteCell("Second note.", { quote: GREEK_QUOTE, occurrence: "2" }),
      ],
      nextCursor: undefined,
    })
    renderSidebar()

    await waitFor(() => expect(screen.getByText("Second note.")).toBeTruthy())
    expect(screen.getByText("occurrence 2")).toBeTruthy()
    expect(screen.queryByText("occurrence 1")).toBeNull()
  })

  it("names the translation-academy article behind the note, not its rc:// URI", async () => {
    fetchFileCells.mockResolvedValue({
      cells: [
        noteCell(NOTE_BODY, {
          quote: GREEK_QUOTE,
          supportReference: "rc://*/ta/man/translate/figs-merism",
        }),
      ],
      nextCursor: undefined,
    })
    renderSidebar()

    await waitFor(() => expect(screen.getByText("See: figs merism")).toBeTruthy())
    expect(screen.queryByText(/rc:\/\//)).toBeNull()
  })

  it("renders a note that carries no metadata as prose, with no empty phrase block", async () => {
    fetchFileCells.mockResolvedValue({
      cells: [noteCell(NOTE_BODY, null)],
      nextCursor: undefined,
    })
    renderSidebar()

    await waitFor(() => expect(screen.getByText(NOTE_BODY)).toBeTruthy())
    expect(screen.queryByText("Original-language phrase this note is about:")).toBeNull()
    expect(screen.queryByText(/^occurrence /)).toBeNull()
    expect(screen.queryByText(/^See: /)).toBeNull()
  })
})
