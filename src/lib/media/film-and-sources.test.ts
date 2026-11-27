// AQU-1758 (Sam's decision 7): Film and Sources behind one project setting.
import { describe, expect, it } from "vitest"
import { filmAndSourcesShown, isBookProject } from "./film-and-sources"

const book = { orderedBy: "sequence" as const }
const unset = {}
const film = { orderedBy: "time" as const }

describe("a book project", () => {
  it("is one whose files are all in reading order", () => {
    expect(isBookProject([book, book])).toBe(true)
    // A file that never says reads as reading order, as everywhere else.
    expect(isBookProject([book, unset])).toBe(true)
  })

  it("is not one with any timed file, nor one with no files yet", () => {
    expect(isBookProject([book, film])).toBe(false)
    expect(isBookProject([])).toBe(false)
    expect(isBookProject(null)).toBe(false)
  })
})

describe("whether Film and Sources show", () => {
  it("is off by default for a book project and on otherwise", () => {
    expect(filmAndSourcesShown(undefined, [book])).toBe(false)
    expect(filmAndSourcesShown(null, [film])).toBe(true)
    expect(filmAndSourcesShown(undefined, [])).toBe(true)
  })

  it("is the project's own choice once someone made it", () => {
    expect(filmAndSourcesShown(true, [book])).toBe(true)
    expect(filmAndSourcesShown(false, [film])).toBe(false)
  })
})

// Import map D#25: one recording or film uploaded into a book project turned
// the tools on for every book.
describe("a recording or film uploaded as its own file", () => {
  const video = { orderedBy: "time" as const, type: "video" as const }
  const audio = { orderedBy: "time" as const, type: "audio" as const }

  it("doesn't stop a book project being one", () => {
    expect(isBookProject([book, video])).toBe(true)
    expect(isBookProject([book, audio, unset])).toBe(true)
  })

  it("leaves the books' tools hidden, and shows them on its own file", () => {
    expect(filmAndSourcesShown(undefined, [book, video])).toBe(false)
    expect(filmAndSourcesShown(undefined, [book, video], book)).toBe(false)
    expect(filmAndSourcesShown(undefined, [book, video], video)).toBe(true)
  })

  it("on its own, or beside subtitles, changes nothing", () => {
    expect(isBookProject([audio])).toBe(false)
    expect(filmAndSourcesShown(undefined, [film, video], film)).toBe(true)
    expect(filmAndSourcesShown(false, [book, video], video)).toBe(false)
  })
})
