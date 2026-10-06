import { describe, it, expect } from "vitest"
import {
  AUDIO_CUES_ROLE,
  SCRIPTURE_FILE_TYPES,
  detectFileType,
  fileHasSections,
  isAudioCueFile,
  isHiddenTimelineFile,
  isSubtitleImportFile,
  isVideoTimedSubtitleFile,
  projectHasScriptureFiles,
  resolveBibleResourcesEnabled,
  resolveFileTimingMode,
  type FileType,
} from "./types"

describe("detectFileType", () => {
  it.each([
    ["page.html", "html"],
    ["book.epub", "epub"],
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

// AQU-997: every book of a migrated Codex project is stored as a `codex` file,
// and `codex` was in neither the FileType union nor SCRIPTURE_FILE_TYPES — so
// `fileHasSections` was false for all of them, which is the single predicate
// behind the Parallel Bibles panel, its collapsed edge tab, and file-tree
// expandability. These guard the set membership directly, because nothing else
// can: the value reaches the client through `f.type as FileType`, so dropping
// it again type-errors nowhere.

describe("fileHasSections — native codex Scripture files (AQU-997)", () => {
  it("treats a codex book as sectioned without needing hasScriptureContent", () => {
    expect(fileHasSections({ type: "codex" })).toBe(true)
    expect(SCRIPTURE_FILE_TYPES.has("codex")).toBe(true)
  })

  it("a project whose books are all codex counts as a scripture project", () => {
    const burmeseOt: { type: FileType }[] = [{ type: "codex" }, { type: "codex" }]
    expect(projectHasScriptureFiles(burmeseOt)).toBe(true)
    // …which is what makes Bible resources default-on for it (AQU-460).
    expect(resolveBibleResourcesEnabled(undefined, projectHasScriptureFiles(burmeseOt))).toBe(true)
  })

  it("'source' — the generic role fallback for a row with no kind — is NOT scripture", () => {
    expect(fileHasSections({ type: "source" })).toBe(false)
    expect(SCRIPTURE_FILE_TYPES.has("source")).toBe(false)
  })
})

// AQU-646: Free timing was withdrawn for subtitle imports at the RESOLVER, not
// at the picker — so that the legacy project-level fallback could not sneak it
// back in behind a hidden control.
//
// AQU-1704 rescoped that withdrawal to the subtitle imports it was reasoned
// about: the ones whose video is actually LINKED (`coreMediaUrl`). The grounds
// were always "their cues are already timed to a video", which is false for an
// audio-only dubbing project whose source is an SRT and which has no video at
// all — and for that project the blanket rule made Free timing unreachable by
// every route at once. So the tests below come in pairs: with footage the mode
// is still fixed, without footage the file is ordinary. Non-subtitle files are
// untouched either way, and those cases are here too so nobody "simplifies"
// the guard into an unconditional return.

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

describe("hidden timeline content", () => {
  it("hides independent text tracks without mistaking them for the audio cue track", () => {
    const textTrack = { role: "timeline-content" }
    expect(isHiddenTimelineFile(textTrack)).toBe(true)
    expect(isAudioCueFile(textTrack)).toBe(false)
    expect(isHiddenTimelineFile({ role: AUDIO_CUES_ROLE })).toBe(true)
    expect(isHiddenTimelineFile({ role: "source" })).toBe(false)
    expect(isHiddenTimelineFile(null)).toBe(false)
  })
})

describe("isVideoTimedSubtitleFile", () => {
  it.each(["vtt", "srt", "sbv"] as const)("%s with footage linked is video-timed", (type) => {
    expect(isVideoTimedSubtitleFile({ type, coreMediaUrl: "https://example.test/ep1.mp4" })).toBe(true)
  })

  it.each(["vtt", "srt", "sbv"] as const)("%s with no footage is not", (type) => {
    expect(isVideoTimedSubtitleFile({ type })).toBe(false)
    expect(isVideoTimedSubtitleFile({ type, coreMediaUrl: null })).toBe(false)
    expect(isVideoTimedSubtitleFile({ type, coreMediaUrl: "" })).toBe(false)
  })

  it("a non-subtitle file is never video-timed, footage or not", () => {
    expect(isVideoTimedSubtitleFile({ type: "audio", coreMediaUrl: "https://example.test/ep1.mp4" })).toBe(false)
    expect(isVideoTimedSubtitleFile(null)).toBe(false)
    expect(isVideoTimedSubtitleFile(undefined)).toBe(false)
  })
})

describe("resolveFileTimingMode", () => {
  it.each(["vtt", "srt", "sbv"] as const)(
    "%s with footage linked still ignores the legacy project-level audioFirst",
    (type) => {
      expect(
        resolveFileTimingMode(
          { type, coreMediaUrl: "https://example.test/ep1.mp4" },
          { audioTimingMode: "audioFirst" },
        ),
      ).toBe("dubbing")
    },
  )

  // AQU-1704 regression guard. The audio-only dubbing case: an SRT source, no
  // video, project set to audioFirst through the API. Before the rescope this
  // read "dubbing", which is why playback kept fitting clips into the imported
  // English cue slots — silence after a short clip, overlap after a long one —
  // however the maintainer set the key.
  it.each(["vtt", "srt", "sbv"] as const)(
    "%s with NO footage honours the project-level audioFirst",
    (type) => {
      expect(resolveFileTimingMode({ type }, { audioTimingMode: "audioFirst" })).toBe("audioFirst")
      expect(resolveFileTimingMode({ type, coreMediaUrl: null }, { audioTimingMode: "audioFirst" })).toBe(
        "audioFirst",
      )
    },
  )

  it.each(["vtt", "srt", "sbv"] as const)(
    "%s with NO footage honours its own stored mode, so the picker is not inert",
    (type) => {
      expect(resolveFileTimingMode({ type, timingMode: "audioFirst" }, null)).toBe("audioFirst")
      expect(resolveFileTimingMode({ type, timingMode: "dubbing" }, { audioTimingMode: "audioFirst" })).toBe(
        "dubbing",
      )
    },
  )

  it("a subtitle file with no footage and no setting anywhere is still Original timing", () => {
    expect(resolveFileTimingMode({ type: "srt" }, null)).toBe("dubbing")
    expect(resolveFileTimingMode({ type: "srt" }, {})).toBe("dubbing")
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
