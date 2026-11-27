import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// AQU-1565 follow-up. WHY: a recording uploaded to (or linked into) an empty
// time-ordered file is that file's OWN programme audio, shared by every row it
// is cut into. Sent without a role, the server stored it as a dub on every row:
// a mic on every line and the file reading "recorded 100%" before anybody had
// dubbed a word. These pin the role on both paths, and that somebody below
// Project Lead (who the server would refuse) is stopped BEFORE anything is
// uploaded or a single row is queued.

const emitted = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
  attaches: [] as Array<Record<string, unknown>>,
  uploads: 0,
}))

vi.mock("@/lib/sync/events-emit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/events-emit")>()
  return {
    ...actual,
    emitSourceCellCreate: vi.fn(async (input: Record<string, unknown>) => {
      emitted.creates.push(input)
      return "evt"
    }),
    emitCellAudioAttach: vi.fn(async (input: Record<string, unknown>) => {
      emitted.attaches.push(input)
      return "evt"
    }),
  }
})

vi.mock("@/lib/import", () => ({
  mediaSegmentSpecsFromSpeech: vi.fn(() => []),
  wholeRecordingSpecs: vi.fn(async () => ({
    durationMs: 8000,
    specs: [
      { cellId: "seg-1", startMs: 0, endMs: 4000, trimStartMs: 0, trimEndMs: 4000 },
      { cellId: "seg-2", startMs: 4000, endMs: 8000, trimStartMs: 4000, trimEndMs: 8000 },
    ],
  })),
}))

vi.mock("@/lib/audio/upload", () => ({
  MAX_AUDIO_OBJECT_BYTES: 2 * 1024 * 1024 * 1024,
  buildAudioId: (id: string) => `${id}-clip`,
  uploadCellAudio: vi.fn(async () => {
    emitted.uploads += 1
    return { audioId: "f1-clip.wav", url: "frontier-audio://f1-clip.wav", ext: "wav" }
  }),
  deleteCellAudio: vi.fn(async () => {}),
}))

vi.mock("@/lib/audio/auto-transcribe", () => ({
  recordMediaImportSeed: vi.fn(),
  buildMediaSeedCells: vi.fn(() => []),
}))

import { attachMediaFileToTimeline, attachMediaUrlToTimeline, SourceAudioLanguageError, type AttachMediaContext } from "./attach-media"
import { setCqrsOutboxBridge } from "@/lib/sync/cqrs-bridge"
import { InsufficientRoleError } from "@/lib/sync/events-emit"
import { ROLE } from "@/lib/frontier/roles"

const ctx: AttachMediaContext = {
  projectId: "p1",
  fileId: "f1",
  author: "lead",
  getToken: async () => "tok",
}

const asRole = (roleLevel: number | null) =>
  setCqrsOutboxBridge({ projectId: "p1", activeFileId: "f1", username: "u", roleLevel })

/** A media element whose metadata "loads" the moment it is given a src. */
function stubVideoProbe(durationSec: number) {
  const real = document.createElement.bind(document)
  return vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "video") return real(tag)
    const el: Record<string, unknown> = { duration: durationSec, removeAttribute: () => {} }
    Object.defineProperty(el, "src", {
      set() {
        queueMicrotask(() => (el.onloadedmetadata as () => void)?.())
      },
    })
    return el as unknown as HTMLElement
  }) as typeof document.createElement)
}

beforeEach(() => {
  emitted.creates.length = 0
  emitted.attaches.length = 0
  emitted.uploads = 0
})

afterEach(() => {
  setCqrsOutboxBridge(null)
  vi.restoreAllMocks()
})

describe("attachMediaFileToTimeline", () => {
  it("attaches the uploaded clip to every row as the file's source audio", async () => {
    asRole(ROLE.PROJECT_LEAD)
    const file = new File([new Uint8Array(16)], "episode.wav", { type: "audio/wav" })
    await expect(attachMediaFileToTimeline(file, ctx)).resolves.toMatchObject({ segments: 2, lines: [expect.anything(), expect.anything()] })
    expect(emitted.attaches).toHaveLength(2)
    for (const a of emitted.attaches) {
      expect(a).toMatchObject({ slot: "recording", role: "source", audioId: "f1-clip.wav" })
    }
  })

  it("refuses a contributor before uploading anything or queueing a row", async () => {
    asRole(ROLE.CONTRIBUTOR)
    const file = new File([new Uint8Array(16)], "episode.wav", { type: "audio/wav" })
    await expect(attachMediaFileToTimeline(file, ctx)).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(emitted.uploads).toBe(0)
    expect(emitted.creates).toHaveLength(0)
    expect(emitted.attaches).toHaveLength(0)
  })

  it("lets an unknown role through, like every other client mirror (the server decides)", async () => {
    asRole(null)
    const file = new File([new Uint8Array(16)], "episode.wav", { type: "audio/wav" })
    await expect(attachMediaFileToTimeline(file, ctx)).resolves.toMatchObject({ segments: 2, lines: [expect.anything(), expect.anything()] })
  })
})

describe("attachMediaUrlToTimeline", () => {
  it("attaches the linked clip as the file's source audio", async () => {
    asRole(ROLE.MAINTAINER)
    stubVideoProbe(12)
    await attachMediaUrlToTimeline("https://cdn.example.com/episode.mp4", ctx)
    expect(emitted.attaches).toHaveLength(1)
    expect(emitted.attaches[0]).toMatchObject({ slot: "recording", role: "source", durationMs: 12000 })
  })

  it("refuses a contributor before probing or queueing anything", async () => {
    asRole(ROLE.CONTRIBUTOR)
    const probe = stubVideoProbe(12)
    await expect(
      attachMediaUrlToTimeline("https://cdn.example.com/episode.mp4", ctx),
    ).rejects.toBeInstanceOf(InsufficientRoleError)
    expect(probe).not.toHaveBeenCalledWith("video")
    expect(emitted.creates).toHaveLength(0)
  })
})

// A video dropped or chosen on the "No media on this file yet" card kept only
// its sound: its picture was lost, though Upload files stores the same upload
// as the file's film. It now comes back as `film` for the workspace to set.
describe("attachMediaFileToTimeline: a video's picture", () => {
  const picture = () => new File([readFileSync(join(__dirname, "..", "..", "..", "e2e", "fixtures", "tone-picture.mp4"))],
    "Episode 101.mp4", { type: "video/mp4" })
  // EBML header, a Segment of unknown size, Tracks with one audio track.
  const soundOnlyWebm = () => new File([Uint8Array.of(
    0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x16, 0x54, 0xae, 0x6b, 0x88, 0xae, 0x86, 0xd7, 0x81, 0x01, 0x83, 0x81, 0x02,
  )], "Mic take.webm", { type: "video/webm" })

  it("keeps a video's picture as the file's film: the same stored upload", async () => {
    asRole(ROLE.PROJECT_LEAD)
    const result = await attachMediaFileToTimeline(picture(), ctx, { keepPicture: true })
    expect(result.film).toBe("frontier-audio://f1-clip.wav")
    expect(emitted.attaches.every((a) => a.url === result.film)).toBe(true)
  })

  it("never replaces a film the file already has", async () => {
    asRole(ROLE.PROJECT_LEAD)
    expect((await attachMediaFileToTimeline(picture(), ctx)).film).toBeUndefined()
  })

  it("gives a recording no film: sound-only .webm, or audio", async () => {
    asRole(ROLE.PROJECT_LEAD)
    expect((await attachMediaFileToTimeline(soundOnlyWebm(), ctx, { keepPicture: true })).film).toBeUndefined()
    const wav = new File([new Uint8Array(16)], "episode.wav", { type: "audio/wav" })
    expect((await attachMediaFileToTimeline(wav, ctx, { keepPicture: true })).film).toBeUndefined()
  })
})

// Import map D#20: a file dropped on an empty file over the limit is refused
// up front, with the importer's sentence, before anything is uploaded.
describe("attachMediaFileToTimeline: over the limit", () => {
  it("says the importer's sentence and uploads nothing", async () => {
    asRole(ROLE.PROJECT_LEAD)
    const huge = new File(["x"], "Episode 101.mov", { type: "video/quicktime" })
    Object.defineProperty(huge, "size", { value: 3 * 1024 * 1024 * 1024 })
    await expect(attachMediaFileToTimeline(huge, ctx)).rejects.toThrow("Episode 101.mov exceeds the 2 GB media import limit.")
    expect(emitted.uploads).toBe(0)
  })
})

// AQU-2682: the server also refuses source audio from someone whose access
// does not cover every language. The workspace puts the server's answer on
// the bridge; without a yes, nothing is uploaded and no row is queued, so a
// Project Lead missing a language is never left with lines and no audio.
describe("access to every language", () => {
  const asLead = (sourceAudioCoversEveryLanguage: boolean | null) =>
    setCqrsOutboxBridge({
      projectId: "p1", activeFileId: "f1", username: "u", roleLevel: ROLE.PROJECT_LEAD, sourceAudioCoversEveryLanguage,
    })
  const file = () => new File([new Uint8Array(16)], "episode.wav", { type: "audio/wav" })

  it("refuses a Project Lead missing a language before uploading or queueing anything", async () => {
    asLead(false)
    await expect(attachMediaFileToTimeline(file(), ctx)).rejects.toBeInstanceOf(SourceAudioLanguageError)
    expect(emitted.uploads).toBe(0)
    expect(emitted.creates).toHaveLength(0)
    expect(emitted.attaches).toHaveLength(0)
  })

  it("refuses a linked url the same way, before probing", async () => {
    asLead(false)
    const probe = stubVideoProbe(12)
    await expect(attachMediaUrlToTimeline("https://cdn.example.com/episode.mp4", ctx)).rejects.toBeInstanceOf(SourceAudioLanguageError)
    expect(probe).not.toHaveBeenCalledWith("video")
    expect(emitted.creates).toHaveLength(0)
  })

  it("refuses while the answer has not arrived (no optimistic attempt)", async () => {
    asLead(null)
    await expect(attachMediaFileToTimeline(file(), ctx)).rejects.toBeInstanceOf(SourceAudioLanguageError)
    expect(emitted.uploads).toBe(0)
  })

  it("lets a Project Lead with every language through", async () => {
    asLead(true)
    await expect(attachMediaFileToTimeline(file(), ctx)).resolves.toMatchObject({ segments: 2 })
    expect(emitted.attaches).toHaveLength(2)
  })
})
