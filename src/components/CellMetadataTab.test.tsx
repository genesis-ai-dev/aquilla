import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CellMetadataTab, hasCellMetadata } from "./CellMetadataTab"

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

  it("falls back to compact JSON for arbitrary nested objects", () => {
    render(<CellMetadataTab metadata={{ tags: ["keyterm", "name"] }} />)
    expect(screen.getByText('["keyterm","name"]')).toBeInTheDocument()
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
