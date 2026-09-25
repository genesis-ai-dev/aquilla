import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { CellMetadataTab, hasCellMetadata } from "./CellMetadataTab"
import {
  __resetCellDisplayFieldsCache,
  getCellDisplayFields,
  setCellDisplayField,
} from "@/lib/store/cell-display-fields"

describe("CellMetadataTab", () => {
  it("renders string/number metadata as key/value pairs so DCS TSV columns stay inspectable", () => {
    // DCS Translation Notes carry untranslated columns the translator needs
    // to see verbatim — the tab must surface them without transformation.
    render(
      <CellMetadataTab
        metadata={{ supportReference: "rc://*/ta/man/translate/figs-metaphor", occurrence: 1 }}
      />,
    )
    expect(screen.getByText("supportReference")).toBeInTheDocument()
    expect(screen.getByText("rc://*/ta/man/translate/figs-metaphor")).toBeInTheDocument()
    expect(screen.getByText("occurrence")).toBeInTheDocument()
    expect(screen.getByText("1")).toBeInTheDocument()
  })

  it("renders OBS image attachments as thumbnails, not raw JSON", () => {
    // OBS stories are illustrated — the picture is the context, so it must
    // render as an image the translator can actually look at.
    render(
      <CellMetadataTab
        metadata={{
          attachments: [
            { type: "image", url: "https://cdn.example.org/obs/01-01.jpg", alt: "Creation" },
          ],
        }}
      />,
    )
    const img = screen.getByRole("img", { name: "Creation" })
    expect(img).toHaveAttribute("src", "https://cdn.example.org/obs/01-01.jpg")
  })

  it("renders non-image attachments as links", () => {
    render(
      <CellMetadataTab
        metadata={{
          attachments: [{ type: "audio", url: "https://cdn.example.org/obs/01-01.mp3" }],
        }}
      />,
    )
    const link = screen.getByRole("link", { name: "https://cdn.example.org/obs/01-01.mp3" })
    expect(link).toHaveAttribute("href", "https://cdn.example.org/obs/01-01.mp3")
  })

  it("renders a list of labels as separate values, not one JSON blob", () => {
    // DCS `tags` is a flat label list — a translator scans it, so each label
    // has to read as its own value rather than as quoted JSON.
    render(<CellMetadataTab metadata={{ tags: ["keyterm", "name"] }} />)
    expect(screen.getByText("keyterm")).toBeInTheDocument()
    expect(screen.getByText("name")).toBeInTheDocument()
    expect(screen.queryByText('["keyterm","name"]')).not.toBeInTheDocument()
  })

  it("labels the keys of a nested object instead of printing JSON", () => {
    // Nested structure carries meaning in its keys; hiding them behind
    // JSON punctuation is what made this tab unreadable.
    render(<CellMetadataTab metadata={{ source: { book: "GEN", chapter: 1 } }} />)
    expect(screen.getByText("source")).toBeInTheDocument()
    expect(screen.getByText("book")).toBeInTheDocument()
    expect(screen.getByText("GEN")).toBeInTheDocument()
    expect(screen.getByText("chapter")).toBeInTheDocument()
    expect(screen.getByText("1")).toBeInTheDocument()
  })

  it("falls back to compact JSON past the nesting depth the layout can carry", () => {
    // Indentation stops paying for itself eventually — beyond that the raw
    // value is more honest than a column of near-empty rows.
    render(<CellMetadataTab metadata={{ a: { b: { c: { d: { e: 1 } } } } }} />)
    expect(screen.getByText('{"e":1}')).toBeInTheDocument()
  })

  describe("show-on-cells toggle (AQU-1369)", () => {
    beforeEach(() => {
      localStorage.clear()
      __resetCellDisplayFieldsCache()
    })

    it("offers no toggle without a project to scope it to", () => {
      render(<CellMetadataTab metadata={{ Field: "glosses" }} />)
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    })

    it("toggles a key on for the whole project, and off again from any cell", () => {
      // Checking a key here is what turns the label on for every cell in
      // the project that has it.
      const { unmount } = render(
        <CellMetadataTab metadata={{ Field: "glosses" }} projectId="p1" />,
      )
      const box = screen.getByRole("checkbox", { name: "Show Field on cells" })
      expect(box).not.toBeChecked()
      fireEvent.click(box)
      expect(getCellDisplayFields("p1")).toEqual(["Field"])
      unmount()

      // A different cell of the same project reflects the setting and can
      // clear it.
      render(<CellMetadataTab metadata={{ Field: "definitions" }} projectId="p1" />)
      const other = screen.getByRole("checkbox", { name: "Show Field on cells" })
      expect(other).toBeChecked()
      fireEvent.click(other)
      expect(getCellDisplayFields("p1")).toEqual([])
    })

    it("offers no toggle for values with no one-line label", () => {
      // Attachments and deeper structures would label nothing — a checkbox
      // there would be a dead control. A nested object gets none itself; its
      // one-line fields get their own (next test).
      render(
        <CellMetadataTab
          metadata={{
            attachments: [{ type: "image", url: "https://cdn.example.org/a.jpg" }],
            source: { ref: { book: "GEN" } },
          }}
          projectId="p1"
        />,
      )
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    })

    it("offers the one-line fields inside a nested object, keyed parent.child", () => {
      // WHY: the SDBH importer keeps every field under `metadata.sdbh`
      // (src/lib/parsers/sdbh.ts). Offering only top-level keys left SDBH
      // projects with no checkbox at all — the AQU-1369 feature was unusable
      // on the project it was built for.
      render(
        <CellMetadataTab
          metadata={{
            tags: ["אָב", "Definition"],
            sdbh: {
              layer: "sense",
              lemma: "אָב",
              partsOfSpeech: "noun",
              domains: [{ code: "001", label: "Family" }],
            },
          }}
          projectId="p1"
        />,
      )
      expect(screen.queryByRole("checkbox", { name: "Show sdbh on cells" })).not.toBeInTheDocument()
      // A list of objects has no one-line label either.
      expect(screen.queryByRole("checkbox", { name: "Show sdbh.domains on cells" })).not.toBeInTheDocument()
      const lemma = screen.getByRole("checkbox", { name: "Show sdbh.lemma on cells" })
      expect(screen.getByRole("checkbox", { name: "Show sdbh.partsOfSpeech on cells" })).toBeInTheDocument()
      fireEvent.click(lemma)
      expect(getCellDisplayFields("p1")).toEqual(["sdbh.lemma"])
    })

    it("reads a key already on from storage as checked", () => {
      setCellDisplayField("p1", "Field", true)
      render(<CellMetadataTab metadata={{ Field: "glosses" }} projectId="p1" />)
      expect(screen.getByRole("checkbox", { name: "Show Field on cells" })).toBeChecked()
    })
  })

  describe("hasCellMetadata (the EditorTable tab gate)", () => {
    // The tab only mounts when this gate passes, so the component may assume
    // non-empty input; the gate is what keeps empty buckets from producing a
    // meaningless empty tab.
    it("rejects null, undefined, and empty objects", () => {
      expect(hasCellMetadata(null)).toBe(false)
      expect(hasCellMetadata(undefined)).toBe(false)
      expect(hasCellMetadata({})).toBe(false)
    })

    it("accepts an object with at least one key", () => {
      expect(hasCellMetadata({ quote: "λόγος" })).toBe(true)
    })
  })
})
