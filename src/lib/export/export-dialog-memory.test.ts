// Remembering where the export dialog was left. (AQU-646, 2026-08-20)
//
// The assertions that matter are about what happens to a value that should
// NOT be trusted: one from an older build naming a format that no longer
// exists, one somebody hand-edited, one belonging to a different person. Every
// one of those is a way for the dialog to open in a state it cannot actually
// be in, which is worse than opening fresh.

import { describe, it, expect, beforeEach } from "vitest"

import {
  DEFAULT_EXPORT_MEMORY,
  normalizeExportMemory,
  readExportMemory,
  writeExportMemory,
} from "./export-dialog-memory"

const KEY = "aq.exportdlg.v1"

beforeEach(() => {
  window.localStorage.clear()
})

describe("keeping one person's choices apart from another's", () => {
  it("gives back what this user chose in this project", () => {
    writeExportMemory("sam", "p1", { ...DEFAULT_EXPORT_MEMORY, section: "fold" })
    expect(readExportMemory("sam", "p1").section).toBe("fold")
  })

  it("does not hand one user another's choices", () => {
    // Two people share a machine; neither should inherit the other's last click.
    writeExportMemory("anna", "p1", { ...DEFAULT_EXPORT_MEMORY, section: "fold" })
    expect(readExportMemory("sam", "p1")).toEqual(DEFAULT_EXPORT_MEMORY)
  })

  it("does not carry a choice from one project into another", () => {
    // A dubbing project is worked one way every time and a translation project
    // another — one global memory would fight itself.
    writeExportMemory("sam", "dubbing", { ...DEFAULT_EXPORT_MEMORY, section: "audio" })
    expect(readExportMemory("sam", "translation")).toEqual(DEFAULT_EXPORT_MEMORY)
  })

  it("replaces rather than appends when the same pair writes twice", () => {
    writeExportMemory("sam", "p1", { ...DEFAULT_EXPORT_MEMORY, section: "audio" })
    writeExportMemory("sam", "p1", { ...DEFAULT_EXPORT_MEMORY, section: "fold" })
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toHaveLength(1)
    expect(readExportMemory("sam", "p1").section).toBe("fold")
  })

  it("keeps the list from growing without bound", () => {
    for (let i = 0; i < 60; i += 1) {
      writeExportMemory("sam", `p${i}`, { ...DEFAULT_EXPORT_MEMORY, section: "audio" })
    }
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toHaveLength(50)
    // Most recent first, so the projects still in use survive the cap.
    expect(readExportMemory("sam", "p59").section).toBe("audio")
    expect(readExportMemory("sam", "p0")).toEqual(DEFAULT_EXPORT_MEMORY)
  })
})

describe("a stored value that cannot be trusted", () => {
  it("falls back to defaults when nothing was ever stored", () => {
    expect(readExportMemory("sam", "p1")).toEqual(DEFAULT_EXPORT_MEMORY)
  })

  it("survives a key holding something that is not JSON at all", () => {
    window.localStorage.setItem(KEY, "{not json")
    expect(readExportMemory("sam", "p1")).toEqual(DEFAULT_EXPORT_MEMORY)
  })

  it("survives a key holding JSON that is not a list", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ section: "fold" }))
    expect(readExportMemory("sam", "p1")).toEqual(DEFAULT_EXPORT_MEMORY)
  })

  it("collapses everything when the stored section no longer exists", () => {
    // Not a fallback to some OTHER section: a stale name says nothing about
    // which of the current three was wanted, and opening one on that basis is
    // a guess dressed as a memory.
    expect(normalizeExportMemory({ section: "featured" }).section).toBeNull()
  })

  it("keeps the rest of a record when one field is nonsense", () => {
    // One bad field should not cost the other five.
    const out = normalizeExportMemory({ section: "audio", audioMode: 47, cueSplitting: true })
    expect(out.section).toBe("audio")
    expect(out.audioMode).toBe("audio-by-character")
    expect(out.cueSplitting).toBe(true)
  })

  it("keeps a remembered chapter-audio mode", () => {
    expect(normalizeExportMemory({ audioMode: "audio-chapter" }).audioMode).toBe("audio-chapter")
  })

  it("refuses a subtitle target it does not recognise", () => {
    expect(normalizeExportMemory({ subtitleTarget: "video" }).subtitleTarget).toBe("subtitle")
  })

  it("reads a checkbox only when it is really a boolean", () => {
    // A stored "true" string would otherwise tick a box nobody ticked.
    expect(normalizeExportMemory({ excludeLabels: "true" }).excludeLabels).toBe(false)
    expect(normalizeExportMemory({ excludeLabels: true }).excludeLabels).toBe(true)
  })

  it("passes the format id through for the dialog to check itself", () => {
    // Deliberately NOT validated here: which ids exist depends on the file
    // type, and only the dialog knows what it is currently offering.
    expect(normalizeExportMemory({ foldFormat: "tmx" }).foldFormat).toBe("tmx")
    expect(normalizeExportMemory({ foldFormat: 7 }).foldFormat).toBeNull()
  })

  it("treats a record that is not an object at all as nothing", () => {
    expect(normalizeExportMemory(null)).toEqual(DEFAULT_EXPORT_MEMORY)
    expect(normalizeExportMemory("fold")).toEqual(DEFAULT_EXPORT_MEMORY)
  })
})
