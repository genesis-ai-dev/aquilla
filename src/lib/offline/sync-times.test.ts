import { afterEach, describe, expect, it } from "vitest"
import { readLastUploadAt, recordOfflineUpload } from "./sync-times"

afterEach(() => localStorage.clear())

describe("offline upload timestamps", () => {
  it("is null until something uploads, then per project", () => {
    expect(readLastUploadAt("p1")).toBeNull()
    recordOfflineUpload("p1", new Date(1_000))
    expect(readLastUploadAt("p1")?.getTime()).toBe(1_000)
    expect(readLastUploadAt("p2")).toBeNull()
  })

  it("ignores a corrupt stored value instead of showing a bogus date", () => {
    localStorage.setItem("aquilla.offline.lastUploadAt.p1", "garbage")
    expect(readLastUploadAt("p1")).toBeNull()
  })
})
