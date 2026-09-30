import { beforeEach, describe, expect, it, vi } from "vitest"

// The completion service is mocked: classification must be exercised without a
// network or an LLM. The factory runs before the module under test is imported.
vi.mock("@/lib/completion/completion-service", () => ({ complete: vi.fn() }))

import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import { BOOK_GENRES } from "@/lib/scripture/book-genres"
import {
  describeFileGenre,
  DOCUMENT_GENRES,
  FILE_GENRES,
  isFileGenre,
  mergeFileGenres,
  normalizeFileGenre,
  parseFileGenreSuggestions,
  resolveFileGenre,
  setFileGenre,
  suggestFileGenres,
} from "./file-genre"

const completeMock = vi.mocked(complete)

const SETTINGS = { model: "test-model", maxTokens: 8192, temperature: 0.7 } as CompletionSettings

beforeEach(() => {
  completeMock.mockReset()
})

// ── Vocabulary ─────────────────────────────────────────────────────────────

describe("genre vocabulary", () => {
  it("keeps every scripture genre, in book-genres order, ahead of the document-only ones", () => {
    expect(FILE_GENRES.slice(0, BOOK_GENRES.length)).toEqual([...BOOK_GENRES])
    expect(FILE_GENRES.slice(BOOK_GENRES.length)).toEqual([...DOCUMENT_GENRES])
    expect(new Set(FILE_GENRES).size).toBe(FILE_GENRES.length)
  })

  it("accepts known ids exactly and normalizes case/whitespace separately", () => {
    expect(isFileGenre("poetry")).toBe(true)
    expect(isFileGenre("Poetry")).toBe(false)
    expect(isFileGenre("hagiography")).toBe(false)
    expect(isFileGenre(7)).toBe(false)

    expect(normalizeFileGenre("  Poetry ")).toBe("poetry")
    expect(normalizeFileGenre("hagiography")).toBeUndefined()
    expect(normalizeFileGenre("")).toBeUndefined()
    expect(normalizeFileGenre(null)).toBeUndefined()
  })
})

// ── Resolution ─────────────────────────────────────────────────────────────

describe("resolveFileGenre", () => {
  it("lets an explicit assignment override the derived scripture genre", () => {
    // PSA derives "poetry"; the human says it reads as wisdom here.
    expect(resolveFileGenre("f1", "PSA", { f1: "wisdom" })).toBe("wisdom")
    expect(describeFileGenre("f1", "PSA", { f1: "wisdom" })).toEqual({
      genre: "wisdom",
      source: "assigned",
    })
  })

  it("assigns a genre to a file that has no book code at all", () => {
    expect(resolveFileGenre("f2", undefined, { f2: "dialogue" })).toBe("dialogue")
    expect(describeFileGenre("f2", undefined, { f2: "dialogue" }).source).toBe("assigned")
  })

  it("falls back to the derived book genre when the file is unassigned", () => {
    expect(resolveFileGenre("f1", "PSA", {})).toBe("poetry")
    expect(resolveFileGenre("f1", "psa", undefined)).toBe("poetry")
    expect(describeFileGenre("f1", "ROM", { other: "poetry" })).toEqual({
      genre: "epistle",
      source: "derived",
    })
  })

  it("has no genre when nothing derives and nothing is assigned", () => {
    expect(resolveFileGenre("f3", undefined, undefined)).toBeUndefined()
    expect(resolveFileGenre("f3", "NOTES", {})).toBeUndefined()
    expect(describeFileGenre("f3", undefined, {})).toEqual({ genre: undefined, source: "none" })
  })

  it("ignores an unknown or blank assignment instead of blanking the derived genre", () => {
    expect(resolveFileGenre("f1", "PSA", { f1: "hagiography" })).toBe("poetry")
    expect(resolveFileGenre("f1", "PSA", { f1: "   " })).toBe("poetry")
    expect(describeFileGenre("f1", "PSA", { f1: "" }).source).toBe("derived")
    // …and a non-scripture file with a junk assignment simply has none.
    expect(resolveFileGenre("f3", undefined, { f3: "hagiography" })).toBeUndefined()
  })

  it("reads a stored assignment case-insensitively", () => {
    expect(resolveFileGenre("f1", "PSA", { f1: "Teaching" })).toBe("teaching")
  })
})

describe("assignment map edits", () => {
  it("adds, replaces and clears one key without touching the others", () => {
    const start = { a: "poetry", b: "epistle" }
    expect(setFileGenre(start, "c", "reference")).toEqual({
      a: "poetry",
      b: "epistle",
      c: "reference",
    })
    expect(setFileGenre(start, "a", "wisdom")).toEqual({ a: "wisdom", b: "epistle" })
    expect(setFileGenre(start, "a", null)).toEqual({ b: "epistle" })
    // Never mutates the input — the caller sends the returned map wholesale.
    expect(start).toEqual({ a: "poetry", b: "epistle" })
  })

  it("clears a key that was never there without inventing one", () => {
    expect(setFileGenre(undefined, "a", null)).toEqual({})
  })

  it("folds confirmed suggestions over the stored map", () => {
    expect(mergeFileGenres({ a: "poetry" }, { b: "teaching" })).toEqual({
      a: "poetry",
      b: "teaching",
    })
    expect(mergeFileGenres({ a: "poetry" }, { a: "wisdom" })).toEqual({ a: "wisdom" })
  })
})

// ── Suggestion parsing ─────────────────────────────────────────────────────

const SUGGESTION_JSON = JSON.stringify([
  { fileId: "f1", genre: "poetry" },
  { fileId: "f2", genre: "teaching" },
])

describe("parseFileGenreSuggestions", () => {
  it("parses a plain JSON array", () => {
    expect(parseFileGenreSuggestions(SUGGESTION_JSON)).toEqual({ f1: "poetry", f2: "teaching" })
  })

  it("strips markdown code fences", () => {
    expect(parseFileGenreSuggestions("```json\n" + SUGGESTION_JSON + "\n```")).toEqual({
      f1: "poetry",
      f2: "teaching",
    })
  })

  it("ignores prose surrounding the array", () => {
    const raw = `Sure — here is what I found:\n${SUGGESTION_JSON}\nHappy to revise.`
    expect(parseFileGenreSuggestions(raw)).toEqual({ f1: "poetry", f2: "teaching" })
  })

  it("returns {} for invalid JSON, a non-array, or no array at all", () => {
    expect(parseFileGenreSuggestions("[{oops}]")).toEqual({})
    expect(parseFileGenreSuggestions('{"f1":"poetry"}')).toEqual({})
    expect(parseFileGenreSuggestions("I could not classify these.")).toEqual({})
    expect(parseFileGenreSuggestions("")).toEqual({})
  })

  it("drops unknown genre ids and keeps the valid entries", () => {
    const raw = JSON.stringify([
      { fileId: "f1", genre: "hagiography" },
      { fileId: "f2", genre: "POETRY" },
    ])
    expect(parseFileGenreSuggestions(raw)).toEqual({ f2: "poetry" })
  })

  it("drops entries whose fileId or genre is not a string", () => {
    const raw = JSON.stringify([
      { fileId: 12, genre: "poetry" },
      { fileId: "f2", genre: 3 },
      { fileId: "f3", genre: null },
      { fileId: "", genre: "poetry" },
      "poetry",
      null,
      { fileId: "f6", genre: "reference" },
    ])
    expect(parseFileGenreSuggestions(raw)).toEqual({ f6: "reference" })
  })

  it("drops files this project does not have when the known set is given", () => {
    expect(parseFileGenreSuggestions(SUGGESTION_JSON, ["f2"])).toEqual({ f2: "teaching" })
  })

  it("keeps the first verdict when the model contradicts itself", () => {
    const raw = JSON.stringify([
      { fileId: "f1", genre: "poetry" },
      { fileId: "f1", genre: "law" },
    ])
    expect(parseFileGenreSuggestions(raw)).toEqual({ f1: "poetry" })
  })
})

// ── Suggestion run ─────────────────────────────────────────────────────────

describe("suggestFileGenres", () => {
  const files = [
    { fileId: "f1", name: "Psalms", sample: "The heavens declare the glory of God." },
    { fileId: "f2", name: "Lesson 3", sample: "Read the passage aloud, then discuss." },
  ]

  it("classifies the batch in ONE call and returns the validated map", async () => {
    completeMock.mockResolvedValue(SUGGESTION_JSON)

    const out = await suggestFileGenres({ files, settings: SETTINGS })

    expect(completeMock).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ f1: "poetry", f2: "teaching" })
  })

  it("caps the token budget and pins a low temperature", async () => {
    completeMock.mockResolvedValue("[]")

    await suggestFileGenres({ files, settings: SETTINGS })

    const settings = completeMock.mock.calls[0][0].settings
    expect(settings.maxTokens).toBe(1024)
    expect(settings.temperature).toBe(0.1)
  })

  it("sends every file's id, name and sample in the one prompt", async () => {
    completeMock.mockResolvedValue("[]")

    await suggestFileGenres({ files, settings: SETTINGS })

    const prompt = completeMock.mock.calls[0][0].messages[1].content
    expect(prompt).toContain("f1")
    expect(prompt).toContain("Psalms")
    expect(prompt).toContain("The heavens declare the glory of God.")
    expect(prompt).toContain("Lesson 3")
  })

  it("never calls the model for an empty batch", async () => {
    expect(await suggestFileGenres({ files: [], settings: SETTINGS })).toEqual({})
    expect(completeMock).not.toHaveBeenCalled()
  })

  it("drops a verdict about a file that was not in the batch", async () => {
    completeMock.mockResolvedValue(
      JSON.stringify([{ fileId: "f1", genre: "poetry" }, { fileId: "elsewhere", genre: "law" }]),
    )

    expect(await suggestFileGenres({ files, settings: SETTINGS })).toEqual({ f1: "poetry" })
  })

  it("reports usage for the call", async () => {
    completeMock.mockResolvedValue("[]")
    const onLlmCall = vi.fn()

    await suggestFileGenres({ files, settings: SETTINGS, onLlmCall })

    expect(onLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file-genre-suggest" }),
    )
  })

  it("propagates a completion failure rather than returning an empty map", async () => {
    completeMock.mockRejectedValue(new Error("model unavailable"))

    await expect(suggestFileGenres({ files, settings: SETTINGS })).rejects.toThrow(
      "model unavailable",
    )
  })
})
