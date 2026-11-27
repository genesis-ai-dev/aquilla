// AQU-2719 — the pure rules behind the living-memory row move.
//
// The end-to-end contract (what a client reads before and after the move) is
// pinned against real Postgres in
// auth-worker/src/__tests__/project-living-memory-rows.test.ts. What is worth
// locking here is the decision table those SQL paths are built on: which blob
// entries can become rows, and when a write is allowed to touch them at all.
import { describe, it, expect } from "vitest"
import {
  mappableLivingMemoryEntry,
  mergeLivingMemoryEntries,
  planLivingMemoryWrite,
  rowsToLivingMemoryEntries,
} from "./living-memory-entries"

const GOOD = { id: "e1", kind: "instruction", text: "Be terse.", createdAt: "2026-01-01", author: "alice" }

describe("mappableLivingMemoryEntry", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["a complete entry", GOOD, GOOD],
    // An id is the row's primary key and what makes a replay a no-op.
    ["no id", { ...GOOD, id: undefined }, null],
    ["an empty id", { ...GOOD, id: "" }, null],
    ["a non-string id", { ...GOOD, id: 7 }, null],
    ["no text", { id: "e1" }, null],
    ["a non-string text", { id: "e1", text: 7 }, null],
    ["not an object", "nope", null],
    ["null", null, null],
    ["an array", [GOOD], null],
    // Everything but id and text is coerced rather than refused: an entry
    // with a damaged `kind` is still somebody's authored note.
    [
      "a damaged kind, missing author and date",
      { id: "e2", text: "keep" },
      { id: "e2", kind: "standard", text: "keep", createdAt: "", author: "" },
    ],
    [
      "a non-string kind",
      { id: "e3", text: "keep", kind: 3, createdAt: 9, author: false },
      { id: "e3", kind: "standard", text: "keep", createdAt: "", author: "" },
    ],
    ["an empty text (a user can author one)", { id: "e4", text: "" }, { id: "e4", kind: "standard", text: "", createdAt: "", author: "" }],
  ]
  for (const [name, input, want] of cases) {
    it(`${want === null ? "refuses" : "carries"} ${name}`, () => {
      expect(mappableLivingMemoryEntry(input)).toEqual(want)
    })
  }
})

describe("rowsToLivingMemoryEntries", () => {
  it("reads the aggregate, and a JSON string form of it", () => {
    expect(rowsToLivingMemoryEntries([GOOD])).toEqual([GOOD])
    expect(rowsToLivingMemoryEntries(JSON.stringify([GOOD]))).toEqual([GOOD])
  })

  it("answers null for anything that is not a usable aggregate", () => {
    // null means "fall back to the blob", never "this project has no entries"
    // — which is what makes an un-migrated project, and every caller that does
    // not select the aggregate, read correctly without a special case.
    for (const raw of [undefined, null, "", "not json", [], {}, 7, [{ nope: true }]]) {
      expect(rowsToLivingMemoryEntries(raw)).toBeNull()
    }
  })
})

describe("mergeLivingMemoryEntries", () => {
  it("hands back the blob value untouched when there are no rows", () => {
    expect(mergeLivingMemoryEntries(null, undefined)).toBeUndefined()
    expect(mergeLivingMemoryEntries(null, [])).toEqual([])
    expect(mergeLivingMemoryEntries(null, { broken: true })).toEqual({ broken: true })
  })

  it("prefers the rows and appends only blob entries they do not carry", () => {
    const rows = [mappableLivingMemoryEntry(GOOD)!]
    const leftover = { id: "e9", text: "still in the blob" }
    expect(mergeLivingMemoryEntries(rows, [GOOD])).toEqual(rows)
    expect(mergeLivingMemoryEntries(rows, [GOOD, leftover])).toEqual([...rows, leftover])
    // An unmappable leftover has no id to match on, so it is always kept.
    expect(mergeLivingMemoryEntries(rows, ["junk"])).toEqual([...rows, "junk"])
  })

  it("ignores a non-array blob value once rows exist", () => {
    const rows = [mappableLivingMemoryEntry(GOOD)!]
    expect(mergeLivingMemoryEntries(rows, { broken: true })).toEqual(rows)
  })
})

describe("planLivingMemoryWrite", () => {
  it("leaves a value that is not an array alone", () => {
    expect(planLivingMemoryWrite([GOOD], { broken: true }).kind).toBe("untouched")
    expect(planLivingMemoryWrite(undefined, undefined).kind).toBe("untouched")
  })

  it("leaves an empty array alone when the project had nothing", () => {
    // Nothing to move, and synthesizing rows or clearing a key nobody wrote
    // would change what the next read returns.
    expect(planLivingMemoryWrite(undefined, []).kind).toBe("untouched")
    expect(planLivingMemoryWrite([], []).kind).toBe("untouched")
  })

  it("owns the rows once there is something to store", () => {
    const plan = planLivingMemoryWrite(undefined, [GOOD])
    expect(plan).toEqual({
      kind: "project",
      entries: [GOOD],
      blobValue: undefined,
      retained: [],
    })
  })

  it("keeps the key present and empty when the last entry is deleted", () => {
    // An absent key is ignored by project-settings-overlay.ts::assign, which
    // would go on showing the entries the user just deleted.
    expect(planLivingMemoryWrite([GOOD], [])).toEqual({
      kind: "project",
      entries: [],
      blobValue: [],
      retained: [],
    })
  })

  it("retains in the blob what it cannot carry, including a duplicate id", () => {
    const junk = { text: "no id" }
    const dupe = { ...GOOD, text: "second copy of e1" }
    const plan = planLivingMemoryWrite(undefined, [GOOD, junk, dupe])
    expect(plan).toEqual({
      kind: "project",
      entries: [GOOD],
      // entry_id is the primary key, so the later copy cannot be a second row
      // — it stays in the blob rather than being silently dropped.
      blobValue: [junk, dupe],
      retained: [junk, dupe],
    })
  })
})
