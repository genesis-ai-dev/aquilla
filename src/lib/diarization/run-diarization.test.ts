import { describe, it, expect } from "vitest"
import { findFileClip, runDiarization } from "./run-diarization"
import type { CellData } from "@/hooks/useCells"

// WHY: diarization must locate the file's shared media clip (R2 object name +
// audioId) from a media cell's attachments to send to /start and re-attach per
// segment. A regression here means "no clip found" or diarizing the wrong audio.

const cell = (c: Partial<CellData>): CellData => ({ id: "c", fileId: "f", original: "", translated: "", context: "", group: "", type: "media", status: "empty", validationStatus: "none", activeValidators: [], validationHistory: [], history: [], threads: [], ...c }) as CellData

describe("findFileClip", () => {
  it("returns the clip object-name + audioId from a media cell's selected attachment", () => {
    const clip = findFileClip([
      cell({
        id: "m1",
        medium: "media",
        selectedAudioId: "audio-x",
        attachments: { "audio-x": { url: "frontier-audio://audio-x.webm", type: "audio" } },
      }),
    ])
    expect(clip).toEqual({ objectName: "audio-x.webm", audioId: "audio-x", url: "frontier-audio://audio-x.webm" })
  })

  it("falls back to the first attachment when selectedAudioId is unset", () => {
    const clip = findFileClip([
      cell({ medium: "media", attachments: { "a.mp3-id": { url: "frontier-audio://a.mp3", type: "audio" } } }),
    ])
    expect(clip?.objectName).toBe("a.mp3")
  })

  it("ignores text cells and returns null when no media clip exists", () => {
    expect(findFileClip([cell({ medium: "text" }), cell({ medium: "media" })])).toBeNull()
  })
})

// AQU-1855: /start refuses with 429 + {error} once the user or project holds the
// cap of live diarization jobs (a job whose Modal callback never arrived used to
// hold a slot forever, which is why the cap exists). The refusal has to reach the
// user as a sentence they can act on — the menu item shows "Diarize failed" and
// the thrown message is what the workspace surfaces.

describe("runDiarization — the server refuses to start", () => {
  const mediaCells = [
    cell({
      id: "m1",
      medium: "media",
      selectedAudioId: "audio-x",
      attachments: { "audio-x": { url: "frontier-audio://audio-x.webm", type: "audio" } },
    }),
  ]

  const args = () => ({
    projectId: "p1",
    fileId: "f1",
    author: "tester",
    cells: mediaCells,
    getToken: async () => "token",
    ttsSettings: undefined,
    saveTts: () => {},
  })

  it("surfaces the live-job cap message, not the raw JSON body", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "you already have 2 speaker-detection job(s) running; wait for one to finish before starting another" }), {
        status: 429,
      })) as unknown as typeof fetch
    try {
      await expect(runDiarization(args())).rejects.toThrow(/wait for one to finish/)
    } finally {
      globalThis.fetch = original
    }
  })

  it("keeps a plain-text refusal readable too", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response("insufficient role", { status: 403 })) as unknown as typeof fetch
    try {
      await expect(runDiarization(args())).rejects.toThrow(/insufficient role/)
    } finally {
      globalThis.fetch = original
    }
  })
})
