import { describe, it, expect } from "vitest"
import { projectHasScriptureFiles, resolveBibleResourcesEnabled, type FileType } from "./types"

// FRO-460 derive-on-read: the effective Bible-resources value must never be
// computed by writing a default on load. These tests encode the trust
// invariant the redesign exists for — an explicit OFF is respected even for
// a scripture project — plus the plain default-on-for-scripture behavior.

describe("resolveBibleResourcesEnabled", () => {
  it("unset + scripture project -> true (derived default-on)", () => {
    expect(resolveBibleResourcesEnabled(undefined, true)).toBe(true)
  })

  it("unset + non-scripture project -> false (derived default-off)", () => {
    expect(resolveBibleResourcesEnabled(undefined, false)).toBe(false)
  })

  it("explicit false wins EVEN IF the project is scripture (the trust invariant)", () => {
    expect(resolveBibleResourcesEnabled(false, true)).toBe(false)
  })

  it("explicit true wins even for a non-scripture project", () => {
    expect(resolveBibleResourcesEnabled(true, false)).toBe(true)
  })

  it("explicit true + scripture -> true", () => {
    expect(resolveBibleResourcesEnabled(true, true)).toBe(true)
  })
})

describe("projectHasScriptureFiles", () => {
  it("true when any file is a scripture type (usfm/ebible/helloao)", () => {
    const files: { type: FileType }[] = [{ type: "docx" }, { type: "usfm" }]
    expect(projectHasScriptureFiles(files)).toBe(true)
  })

  it("false when no file is a scripture type", () => {
    const files: { type: FileType }[] = [{ type: "docx" }, { type: "txt" }]
    expect(projectHasScriptureFiles(files)).toBe(false)
  })

  it("false for undefined/empty file lists", () => {
    expect(projectHasScriptureFiles(undefined)).toBe(false)
    expect(projectHasScriptureFiles([])).toBe(false)
  })
})
