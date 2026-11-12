// AQU-1700 — the Bible Knowledge Pack's IndexedDB cache stays bounded.
//
// What this protects: with the Old Testament a book's layer files reach about
// 12 MB, so a translator who opens many books must not fill the browser's
// storage. Each layer keeps the BOOKS_PER_LAYER books used most recently; the
// book being read is never the one evicted, reading a book counts as using
// it, and a new pack version still replaces the old one's files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BOOKS_PER_LAYER,
  MANIFEST_RECORD_KEY,
  __clearPackStore,
  __packRecordKeys,
  packFileKey,
  prunePackRecords,
  readPackRecord,
  writePackRecord,
} from "./pack-store"

const VERSION = "1.2.0"
/** More books than one layer keeps. */
const BOOKS = ["GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH"]

async function store(layer: string, book: string, version = VERSION): Promise<void> {
  await writePackRecord({ key: packFileKey(version, layer, book), version, data: { book }, storedAt: Date.now() })
}

async function booksOf(layer: string, version = VERSION): Promise<string[]> {
  const prefix = `${version}/${layer}/`
  return (await __packRecordKeys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
}

beforeEach(async () => {
  await __clearPackStore()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a cap per layer", () => {
  it("keeps the most recently stored books of a layer, and drops the oldest", async () => {
    expect(BOOKS.length).toBeGreaterThan(BOOKS_PER_LAYER)
    for (const book of BOOKS) await store("text", book)
    const kept = await booksOf("text")
    expect(kept).toHaveLength(BOOKS_PER_LAYER)
    expect(kept).not.toContain("GEN")
    expect(kept).not.toContain("EXO")
    // The book just stored (the one being read) is always kept.
    expect(kept).toContain("2CH")
  })

  it("counts a read as a use, so a book read again outlives books stored after it", async () => {
    for (const book of BOOKS.slice(0, BOOKS_PER_LAYER)) await store("text", book)
    // Genesis is opened again before two more books arrive.
    expect(await readPackRecord(packFileKey(VERSION, "text", "GEN"))).toBeDefined()
    await store("text", "1CH")
    await store("text", "2CH")
    const kept = await booksOf("text")
    expect(kept).toContain("GEN")
    expect(kept).not.toContain("EXO")
    expect(kept).not.toContain("LEV")
  })

  it("counts each layer apart: a full text layer evicts no people file", async () => {
    await store("people", "GEN")
    for (const book of BOOKS) await store("text", book)
    expect(await booksOf("people")).toEqual(["GEN"])
  })

  it("never evicts the last manifest seen online", async () => {
    await writePackRecord({ key: MANIFEST_RECORD_KEY, version: VERSION, data: {}, storedAt: Date.now() })
    for (const book of BOOKS) await store("text", book)
    expect(await __packRecordKeys()).toContain(MANIFEST_RECORD_KEY)
  })
})

describe("pruning old versions", () => {
  it("drops every file of an older pack version, and keeps the current one's", async () => {
    await store("text", "RUT", "1.1.0")
    await store("text", "RUT")
    await prunePackRecords(VERSION)
    expect(await __packRecordKeys()).toEqual([packFileKey(VERSION, "text", "RUT")])
  })
})

describe("a write the browser refuses", () => {
  it("resolves without throwing (a full disk leaves the file uncached, nothing worse)", async () => {
    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError")
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw quota
    })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(store("text", "JER")).resolves.toBeUndefined()
    vi.restoreAllMocks()
    expect(await booksOf("text")).toEqual([])
  })
})
