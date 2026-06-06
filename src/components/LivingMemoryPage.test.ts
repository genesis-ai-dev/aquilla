import { describe, it, expect } from "vitest"
import { addEntry, updateEntry, deleteEntry } from "./LivingMemoryPage"

describe("LivingMemoryPage entry CRUD helpers", () => {
  it("addEntry appends a new entry with the given kind and text", () => {
    const result = addEntry([], "instruction", "Translate literally", "alice")
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("instruction")
    expect(result[0].text).toBe("Translate literally")
    expect(result[0].author).toBe("alice")
    expect(result[0].id).toBeTruthy()
    expect(result[0].createdAt).toBeTruthy()
  })

  it("addEntry trims whitespace from text", () => {
    const result = addEntry([], "standard", "  Use formal register  ", "bob")
    expect(result[0].text).toBe("Use formal register")
  })

  it("addEntry does not mutate the original array", () => {
    const orig: ReturnType<typeof addEntry> = []
    addEntry(orig, "instruction", "x", "alice")
    expect(orig).toHaveLength(0)
  })

  it("updateEntry changes only the text of the targeted entry", () => {
    const entries = addEntry([], "instruction", "Old text", "alice")
    const id = entries[0].id
    const updated = updateEntry(entries, id, "New text")
    expect(updated).toHaveLength(1)
    expect(updated[0].text).toBe("New text")
    expect(updated[0].id).toBe(id)
    expect(updated[0].kind).toBe("instruction")
  })

  it("updateEntry is a no-op for unknown id", () => {
    const entries = addEntry([], "standard", "text", "alice")
    const updated = updateEntry(entries, "nonexistent", "changed")
    expect(updated[0].text).toBe("text")
  })

  it("deleteEntry removes the entry with the given id", () => {
    let entries = addEntry([], "instruction", "a", "alice")
    entries = addEntry(entries, "standard", "b", "bob")
    const idToDelete = entries[0].id
    const result = deleteEntry(entries, idToDelete)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("b")
  })

  it("deleteEntry is a no-op for unknown id", () => {
    const entries = addEntry([], "instruction", "a", "alice")
    expect(deleteEntry(entries, "bad-id")).toHaveLength(1)
  })
})
