import { describe, it, expect } from "vitest"
import { toast } from "./toast"

describe("toast dedupe", () => {
  it("upserts identical content instead of allocating a new id", () => {
    const first = toast.add({ type: "success", title: "Email copied to clipboard" })
    const second = toast.add({ type: "success", title: "Email copied to clipboard" })
    expect(second).toBe(first)
  })

  it("keeps distinct messages on distinct ids", () => {
    const a = toast.add({ type: "success", title: "Validated 1 cell" })
    const b = toast.add({ type: "success", title: "Validated 2 cells" })
    expect(b).not.toBe(a)
  })

  it("honors an explicit id for status-style upserts", () => {
    const first = toast.add({ id: "save-status", title: "Draft saved" })
    const second = toast.add({
      id: "save-status",
      title: "Draft saved",
      description: "Still the same toast.",
    })
    expect(second).toBe(first)
    expect(first).toBe("save-status")
  })
})
