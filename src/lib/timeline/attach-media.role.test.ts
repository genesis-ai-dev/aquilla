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
  computeMediaSegmentSpecs: vi.fn(async () => ({
    durationMs: 8000,
    specs: [
      { cellId: "seg-1", startMs: 0, endMs: 4000, trimStartMs: 0, trimEndMs: 4000 },
      { cellId: "seg-2", startMs: 4000, endMs: 8000, trimStartMs: 4000, trimEndMs: 8000 },
    ],
  })),
}))

vi.mock("@/lib/audio/upload", () => ({
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

import { attachMediaFileToTimeline, attachMediaUrlToTimeline, type AttachMediaContext } from "./attach-media"
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
    await expect(attachMediaFileToTimeline(file, ctx)).resolves.toEqual({ segments: 2 })
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
    await expect(attachMediaFileToTimeline(file, ctx)).resolves.toEqual({ segments: 2 })
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
