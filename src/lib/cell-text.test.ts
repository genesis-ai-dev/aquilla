import { describe, it, expect } from "vitest"
import { cellTextForDisplay, truncateCellText } from "./cell-text"

describe("cellTextForDisplay", () => {
  it("returns plain text unchanged", () => {
    expect(cellTextForDisplay("Hello world")).toBe("Hello world")
  })

  it("unwraps JSON value wrappers", () => {
    expect(cellTextForDisplay('{"value":"Questo è testo in grassetto 90"}')).toBe(
      "Questo è testo in grassetto 90",
    )
  })

  it("returns original text when JSON has no value field", () => {
    expect(cellTextForDisplay('{"foo":"bar"}')).toBe('{"foo":"bar"}')
  })

  it("returns original text for invalid JSON", () => {
    expect(cellTextForDisplay("{not json}")).toBe("{not json}")
  })

  it("handles empty and nullish input", () => {
    expect(cellTextForDisplay("")).toBe("")
    expect(cellTextForDisplay(null)).toBe("")
    expect(cellTextForDisplay(undefined)).toBe("")
  })
})

describe("truncateCellText", () => {
  it("truncates long strings", () => {
    expect(truncateCellText("abcdefghij", 5)).toBe("abcde…")
  })

  it("leaves short strings unchanged", () => {
    expect(truncateCellText("hi", 5)).toBe("hi")
  })
})

// SUB-28: effective (semantic) source text.
import { effectiveSourceText } from "./cell-text"

describe("effectiveSourceText", () => {
  it("media section with a transcript → the transcript", () => {
    expect(
      effectiveSourceText({ medium: "media", original: "episode.mp3", transcription: "hello world" }),
    ).toBe("hello world")
  })

  it("untranscribed media section → empty (the filename is never source text)", () => {
    expect(effectiveSourceText({ medium: "media", original: "episode.mp3" })).toBe("")
    expect(
      effectiveSourceText({ medium: "media", original: "episode.mp3", transcription: "   " }),
    ).toBe("")
  })

  it("text cells (and missing medium) → original, unchanged", () => {
    expect(effectiveSourceText({ medium: "text", original: "a verse" })).toBe("a verse")
    expect(effectiveSourceText({ original: "a verse" })).toBe("a verse")
    expect(effectiveSourceText({ medium: null, original: "a verse" })).toBe("a verse")
  })
})

// AQU-847: correcting a media section's transcription in the source editor.
// The bug: the editor seeded from `original` (the import FILENAME) and its
// commit wrote `value`, so the correction was discarded and the file title
// took the cell over — permanently, once `originalHtml` started shadowing it.
import {
  displayedSourceText,
  projectedSourceValue,
  sourceCommitFields,
  sourceEditorSeed,
} from "./cell-text"

const mediaCell = {
  medium: "media" as const,
  original: "episode.mp3",
  originalHtml: undefined,
  transcription: "in the beginning was the word",
}
const textCell = { medium: "text" as const, original: "a verse", originalHtml: "<p>a verse</p>" }

describe("sourceEditorSeed (AQU-847)", () => {
  it("a transcribed media section opens on its TRANSCRIPT, never the filename", () => {
    expect(sourceEditorSeed(mediaCell)).toEqual({
      text: "in the beginning was the word",
      html: undefined,
    })
  })

  it("an untranscribed media section opens EMPTY — the filename is a placeholder, not content", () => {
    expect(sourceEditorSeed({ medium: "media", original: "episode.mp3" })).toEqual({
      text: "",
      html: undefined,
    })
  })

  it("a media section never seeds html, even when the filename row carries some", () => {
    expect(sourceEditorSeed({ ...mediaCell, originalHtml: "<p>episode.mp3</p>" }).html).toBeUndefined()
  })

  it("text cells seed from original + originalHtml, unchanged", () => {
    expect(sourceEditorSeed(textCell)).toEqual({ text: "a verse", html: "<p>a verse</p>" })
  })
})

describe("sourceCommitFields (AQU-847)", () => {
  it("a media edit persists as `transcription`, leaving the filename `value` intact", () => {
    expect(sourceCommitFields(mediaCell, { value: "In the beginning was the Word.", valueHtml: "<p>x</p>" })).toEqual({
      value: "episode.mp3",
      valueHtml: undefined,
      transcription: "In the beginning was the Word.",
    })
  })

  it("clearing a media section's text clears the transcript, not the filename", () => {
    expect(sourceCommitFields(mediaCell, { value: "" })).toEqual({
      value: "episode.mp3",
      valueHtml: undefined,
      transcription: "",
    })
  })

  it("text cells still commit value/valueHtml and carry NO transcription", () => {
    const fields = sourceCommitFields(textCell, { value: "an edited verse", valueHtml: "<p>an edited verse</p>" })
    expect(fields).toEqual({ value: "an edited verse", valueHtml: "<p>an edited verse</p>" })
    expect(fields.transcription).toBeUndefined()
  })
})

describe("displayedSourceText (AQU-847)", () => {
  it("shows the transcript for a transcribed media section", () => {
    expect(displayedSourceText(mediaCell, undefined)).toBe("in the beginning was the word")
  })

  it("falls back to the filename placeholder only while untranscribed", () => {
    expect(displayedSourceText({ medium: "media", original: "episode.mp3" }, undefined)).toBe("episode.mp3")
  })

  it("an optimistic draft wins over both", () => {
    expect(displayedSourceText(mediaCell, "corrected")).toBe("corrected")
    expect(displayedSourceText(textCell, "corrected")).toBe("corrected")
  })
})

describe("projectedSourceValue (AQU-847)", () => {
  it("a media draft reconciles against `transcription`, so it can actually clear", () => {
    expect(projectedSourceValue(mediaCell)).toBe("in the beginning was the word")
    expect(projectedSourceValue({ medium: "media", original: "episode.mp3" })).toBe("")
  })

  it("a text draft reconciles against `original`", () => {
    expect(projectedSourceValue(textCell)).toBe("a verse")
  })
})
