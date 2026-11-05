import { describe, expect, it } from "vitest"
import {
  AUDIO_FILE_ACCEPT,
  AUDIO_FILE_EXTS,
  AUDIO_FILE_EXT_SET,
  AUDIO_FORMATS_LABEL,
  UNPLAYABLE_AUDIO_EXTS,
  audioMimeForExt,
} from "./mime"

// WHY these tests exist (AQU: "mp3 audio basically unusable"):
// Playback wraps downloaded bytes in a Blob and hands the object URL to an
// <audio> element. Safari/Firefox trust the Blob's MIME type — an mp3 labeled
// "audio/wav" (or typeless) fails to decode and surfaces only as a generic
// "Audio failed to load". The MIME must therefore be derived from the real
// extension carried in the frontier-audio:// URL, never hardcoded.
describe("audioMimeForExt", () => {
  it("maps the formats the importer accepts", () => {
    expect(audioMimeForExt("mp3")).toBe("audio/mpeg")
    expect(audioMimeForExt("wav")).toBe("audio/wav")
    expect(audioMimeForExt("m4a")).toBe("audio/mp4")
    expect(audioMimeForExt("aac")).toBe("audio/aac")
    expect(audioMimeForExt("flac")).toBe("audio/flac")
    expect(audioMimeForExt("ogg")).toBe("audio/ogg")
    expect(audioMimeForExt("oga")).toBe("audio/ogg")
    expect(audioMimeForExt("opus")).toBe("audio/ogg")
    expect(audioMimeForExt("webm")).toBe("audio/webm")
  })

  it("is case-insensitive and tolerates a leading dot", () => {
    expect(audioMimeForExt("MP3")).toBe("audio/mpeg")
    expect(audioMimeForExt(".wav")).toBe("audio/wav")
  })

  it("falls back to audio/mpeg for unknown extensions rather than lying with wav", () => {
    // An unknown container is far more likely to be an mpeg-family stream than
    // RIFF/WAV; and Chromium sniffs anyway. Never default to audio/wav — that
    // is the exact label that made Safari refuse valid mp3 bytes.
    expect(audioMimeForExt("bin")).toBe("audio/mpeg")
    expect(audioMimeForExt("")).toBe("audio/mpeg")
  })
})

// WHY these tests exist (AQU-1922): the accepted-format list used to be
// re-typed at every call site — two validator Sets and four `accept` strings —
// and had drifted: the one-file picker's `accept` named 4 of the 10 supported
// extensions, so a FLAC/Opus/AAC/WebM pick off a phone (empty or wrong MIME,
// the case the extension list exists for) could not be selected at all. The
// list now lives here once; these guard it against drifting again.
describe("the accepted audio-format list (AQU-1922)", () => {
  it("names exactly the extensions audioMimeForExt maps explicitly", () => {
    // An extension the MIME mapper has to GUESS for is one playback cannot
    // label honestly — Safari refuses a wrongly-labelled Blob outright. So the
    // accepted list and the mapper's explicit arms are the same set, and this
    // fails the moment one gains an entry the other lacks.
    const explicit: Record<string, string> = {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      mp4: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      opus: "audio/ogg",
      webm: "audio/webm",
      flac: "audio/flac",
    }
    expect([...AUDIO_FILE_EXTS].sort()).toEqual(Object.keys(explicit).sort())
    for (const [ext, mime] of Object.entries(explicit)) {
      expect(audioMimeForExt(ext)).toBe(mime)
    }
  })

  it("offers every supported extension in the picker's accept string, plus audio/*", () => {
    const parts = AUDIO_FILE_ACCEPT.split(",")
    expect(parts[0]).toBe("audio/*")
    for (const ext of AUDIO_FILE_EXTS) expect(parts).toContain(`.${ext}`)
    expect(parts).toHaveLength(AUDIO_FILE_EXTS.length + 1)
  })

  it("never offers a format a browser cannot decode", () => {
    for (const ext of UNPLAYABLE_AUDIO_EXTS) {
      expect(AUDIO_FILE_EXT_SET.has(ext)).toBe(false)
      expect(AUDIO_FILE_ACCEPT).not.toContain(`.${ext}`)
    }
  })

  it("names only formats it actually accepts in the sentence shown to people", () => {
    // The prose folds container aliases in (.mp4 ≡ .m4a, .oga/.opus are Ogg),
    // so it is a subset — but every format it promises must really be accepted.
    const named = AUDIO_FORMATS_LABEL.match(/\.[a-z0-9]+/g) ?? []
    expect(named.length).toBeGreaterThan(0)
    for (const dotted of named) expect(AUDIO_FILE_EXT_SET.has(dotted.slice(1))).toBe(true)
  })
})
