import { describe, expect, it } from "vitest"
import { v4 as uuidv4, v7 as uuidv7 } from "uuid"
import { SHORT_CELL_ID_LENGTH, shortCellId } from "./short-cell-id"

describe("shortCellId (AQU-1069 regression guard)", () => {
  it("keeps the trailing significant hex digits, dashes stripped", () => {
    expect(shortCellId("01a0e220-19fd-77b5-963e-2bc27ce06187")).toBe("7ce06187")
    expect(shortCellId(`x`.repeat(SHORT_CELL_ID_LENGTH))).toBe("x".repeat(SHORT_CELL_ID_LENGTH))
    expect(shortCellId("ab-cd")).toBe("abcd")
    expect(shortCellId("")).toBe("")
  })

  it("stays distinct across a whole import's worth of UUIDv7 cell ids", () => {
    // This is the bug: a UUIDv7's LEADING digits are the millisecond clock, so
    // every cell minted by one bulk import shares them. Front-truncation made
    // hundreds of distinct cells render the same "id" (AQU-1069); the short
    // form must not.
    const ids = Array.from({ length: 500 }, () => uuidv7())
    expect(new Set(ids.map((id) => id.slice(0, SHORT_CELL_ID_LENGTH))).size).toBe(1)
    expect(new Set(ids.map(shortCellId)).size).toBe(ids.length)
  })

  it("stays distinct for UUIDv4 cell ids too", () => {
    const ids = Array.from({ length: 500 }, () => uuidv4())
    expect(new Set(ids.map(shortCellId)).size).toBe(ids.length)
  })
})
