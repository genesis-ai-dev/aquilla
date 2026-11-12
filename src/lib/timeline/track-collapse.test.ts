// AQU-1684: hidden tracks are kept like closed folders — personal, per file, on
// this device — and the two never share a key.
import { beforeEach, describe, expect, it } from "vitest"
import { loadCollapsedFolders, loadHiddenTracks, saveCollapsedFolders, saveHiddenTracks } from "./track-collapse"

beforeEach(() => localStorage.clear())

describe("hidden tracks on this device", () => {
  it("are kept per file, apart from closed folders", () => {
    saveHiddenTracks("f1", new Set(["source-audio"]))
    saveCollapsedFolders("f1", new Set(["folder-1"]))
    expect([...loadHiddenTracks("f1")]).toEqual(["source-audio"])
    expect([...loadCollapsedFolders("f1")]).toEqual(["folder-1"])
    expect(loadHiddenTracks("f2").size).toBe(0)
  })

  it("leave no trace once every track is shown again, and read a bad value as none", () => {
    saveHiddenTracks("f1", new Set(["a"]))
    saveHiddenTracks("f1", new Set())
    expect(localStorage.getItem("aquilla:tlTracksHidden:f1")).toBeNull()
    localStorage.setItem("aquilla:tlTracksHidden:f1", "{not json")
    expect(loadHiddenTracks("f1").size).toBe(0)
  })
})
