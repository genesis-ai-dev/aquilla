// AQU-1685: Bible data shows only on a device that opted in, and only while a
// Bible is open. These pin both halves, because each one alone is the bug: the
// switch alone would put Bible data on a story file; "a Bible is open" alone
// would show an unreleased experiment to every scripture project.

import { describe, expect, it } from "vitest"
import { FLAGS } from "@/lib/features/flags"
import { BIBLE_DATA_FLAG, isBibleDataExperimentOn, isBibleEntityLinkAvailable, isBibleOpen } from "./experiment"

describe("isBibleDataExperimentOn", () => {
  it("is off for a device that never chose, because the experiment ships off", () => {
    expect(FLAGS[BIBLE_DATA_FLAG].default).toBe(false)
    expect(isBibleDataExperimentOn({})).toBe(false)
    expect(isBibleDataExperimentOn({ experimentalFlags: { agentModes: true } })).toBe(false)
    expect(isBibleDataExperimentOn(null)).toBe(false)
  })

  it("follows this device's stored choice", () => {
    expect(isBibleDataExperimentOn({ experimentalFlags: { bibleData: true } })).toBe(true)
    expect(isBibleDataExperimentOn({ experimentalFlags: { bibleData: false } })).toBe(false)
  })

  it("is offered as a switch in Settings → Experimental", () => {
    expect(FLAGS[BIBLE_DATA_FLAG].legacy).toBeUndefined()
  })
})

describe("isBibleOpen (the Parallel Bibles panel's condition)", () => {
  it("is true only for the editor on a scripture file", () => {
    expect(isBibleOpen("editor", { type: "usfm" })).toBe(true)
    // A spreadsheet or custom import that carries scripture content counts.
    expect(isBibleOpen("editor", { type: "csv", hasScriptureContent: true })).toBe(true)
  })

  it("is false on other surfaces, other files, or no file", () => {
    expect(isBibleOpen("terminology", { type: "usfm" })).toBe(false)
    expect(isBibleOpen("agent", { type: "usfm" })).toBe(false)
    expect(isBibleOpen("editor", { type: "docx" })).toBe(false)
    expect(isBibleOpen("editor", null)).toBe(false)
  })
})

// AQU-1693: Terminology's "Link to a Bible person, place or group" is not a
// Bible-open surface, but its picker reads the pack directly, so it needs both
// this device's experiment and the project's Bible data switch.
describe("isBibleEntityLinkAvailable", () => {
  const scripture = [{ type: "usfm" as const }]
  const on = { experimentalFlags: { bibleData: true } }

  it("needs the experiment on this device", () => {
    expect(isBibleEntityLinkAvailable(null)).toBe(false)
    expect(isBibleEntityLinkAvailable({ files: scripture })).toBe(false)
    expect(isBibleEntityLinkAvailable({ ...on, files: scripture })).toBe(true)
  })

  it("follows the project's Bible data switch, which defaults on for a scripture project", () => {
    expect(isBibleEntityLinkAvailable({ ...on, files: scripture, bibleResourcesEnabled: false })).toBe(false)
    expect(isBibleEntityLinkAvailable({ ...on, files: [{ type: "docx" as const }] })).toBe(false)
    expect(isBibleEntityLinkAvailable({ ...on, files: [{ type: "docx" as const }], bibleResourcesEnabled: true })).toBe(true)
  })
})
