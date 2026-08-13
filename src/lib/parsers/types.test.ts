import { describe, it, expect } from "vitest"
import {
  AUDIO_CUES_ROLE,
  detectFileType,
  fileHasSections,
  isAudioCueFile,
  isSubtitleImportFile,
  projectHasScriptureFiles,
  resolveBibleResourcesEnabled,
  resolveFileTimingMode,
  type FileType,
} from "./types"

describe("detectFileType", () => {
  it.each([
    ["page.html", "html"],
    ["messages.arb", "json"],
    ["catalog.pot", "po"],
    ["messages.properties", "properties"],
    ["captions.sbv", "sbv"],
    ["workbook.xlsx", "xlsx"],
  ] as const)("routes %s to the deterministic %s adapter", (name, type) => {
    expect(detectFileType(name)).toBe(type)
  })
})

// AQU-460 derive-on-read: the effective Bible-resources value must never be
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

  it("recognizes canonical Scripture content without changing the source format", () => {
    const mappedSpreadsheet = { type: "xlsx" as const, hasScriptureContent: true }
    expect(fileHasSections(mappedSpreadsheet)).toBe(true)
    expect(projectHasScriptureFiles([{ type: "docx" }, mappedSpreadsheet])).toBe(true)
  })

  it("false for undefined/empty file lists", () => {
    expect(projectHasScriptureFiles(undefined)).toBe(false)
    expect(projectHasScriptureFiles([])).toBe(false)
  })
})

// AQU-646: Free timing was withdrawn for subtitle imports at the RESOLVER, not
// at the picker. These tests are the guard on that choice — each one below
// stands for a way the mode reaches a VTT file with the control already hidden
// (its own stored value, the legacy project-level fallback, a write from an
// older client that still offers it), and every one of them must read as
// Original timing. Non-subtitle files are untouched: the mode still exists for
// audio/video imports, and the cases proving that are here too so nobody
// "simplifies" the guard into an unconditional return.

describe("isSubtitleImportFile", () => {
  it.each([
    ["vtt", true],
    ["srt", true],
    ["sbv", true],
    ["audio", false],
    ["video", false],
    ["usfm", false],
  ] as const)("%s -> %s", (type, expected) => {
    expect(isSubtitleImportFile({ type })).toBe(expected)
  })

  it("no file is not a subtitle file (callers pass activeFile, which is null before one is open)", () => {
    expect(isSubtitleImportFile(null)).toBe(false)
    expect(isSubtitleImportFile(undefined)).toBe(false)
  })
})

describe("isAudioCueFile", () => {
  it("keys off role alone — the sibling's type is 'vtt' like a real import", () => {
    expect(isAudioCueFile({ role: AUDIO_CUES_ROLE })).toBe(true)
    expect(isAudioCueFile({ role: "source" })).toBe(false)
    expect(isAudioCueFile({})).toBe(false)
    expect(isAudioCueFile(null)).toBe(false)
    expect(isAudioCueFile(undefined)).toBe(false)
  })
})

describe("resolveFileTimingMode", () => {
  it.each(["vtt", "srt", "sbv"] as const)(
    "%s ignores its own stored audioFirst — whoever wrote it, including an older client",
    (type) => {
      expect(resolveFileTimingMode({ type, timingMode: "audioFirst" }, null)).toBe("dubbing")
    },
  )

  it("a vtt with no mode of its own ignores the legacy project-level audioFirst", () => {
    expect(resolveFileTimingMode({ type: "vtt" }, { audioTimingMode: "audioFirst" })).toBe("dubbing")
  })

  it("audio files keep Free timing, from their own value or the project's", () => {
    expect(resolveFileTimingMode({ type: "audio", timingMode: "audioFirst" }, null)).toBe("audioFirst")
    expect(resolveFileTimingMode({ type: "audio" }, { audioTimingMode: "audioFirst" })).toBe("audioFirst")
  })

  it("a non-subtitle file's own mode still wins over the project's", () => {
    expect(
      resolveFileTimingMode({ type: "audio", timingMode: "dubbing" }, { audioTimingMode: "audioFirst" }),
    ).toBe("dubbing")
  })

  it("no file / no project defaults to Original timing", () => {
    expect(resolveFileTimingMode(null, null)).toBe("dubbing")
    expect(resolveFileTimingMode(undefined, undefined)).toBe("dubbing")
    expect(resolveFileTimingMode({ type: "audio" }, {})).toBe("dubbing")
  })
})
