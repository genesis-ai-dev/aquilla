import { describe, expect, it } from "vitest"
import { audioMimeForExt } from "./mime"

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
