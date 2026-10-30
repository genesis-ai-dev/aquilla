// AQU-981 check 8 (Oct 29): LangQuest writes a multi-card version as one take,
// the first card the take and the rest its pieces — and each card is its OWN
// recording (url), with no trims. The line's own player (the rail's play
// button, the Recording tab) opens the selected attachment's recording and
// plays the take's window over it (takePlayWindow), joining pieces only from
// that one recording's bytes. So it sounds the first card and never the rest.
// Known failure, not fixed here: when it is, vitest reports this test as
// failing — drop `.fails`.
import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { buildFrontierAudioUrl } from "@/lib/audio/upload"
import { takePlayWindow } from "@/lib/audio/kept-window"
import { langquestAudioId } from "@/lib/langquest/plan"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: null }) }))
// Each card's recording, by its id: 0.5 s, 0.7 s and 0.9 s of 48 kHz mono.
const cards = vi.hoisted(() => ({ bytes: new Map<string, Uint8Array>() }))
vi.mock("@/lib/audio/bytes-cache", () => ({
  audioCacheGet: async (audioId: string) => cards.bytes.get(audioId) ?? null,
  audioCachePut: async () => {},
  audioCacheEvict: async () => {},
}))

import { useCellAudio } from "./useCellAudio"

class FakeAudio {
  src = ""
  currentTime = 0
  duration = 0
  readyState = 1
  ended = false
  paused = true
  volume = 1
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  constructor(src?: string) { if (src) this.src = src }
  async play() { this.paused = false; this.onplay?.() }
  pause() { this.paused = true; this.onpause?.() }
  addEventListener() {}
  removeEventListener() {}
}
let blobs: Blob[] = []

const CELL_ID = "4f9c2a1e-7b3d-5e6f-8a9b-0c1d2e3f4a5b"
const SECONDS = [0.5, 0.7, 0.9]
const ids = SECONDS.map((_, i) => langquestAudioId(CELL_ID, { hash: `01h${i}` }))

beforeEach(async () => {
  blobs = []
  cards.bytes.clear()
  for (const [i, id] of ids.entries()) {
    cards.bytes.set(id, new Uint8Array(await encodeWavPcm16(new Float32Array(Math.round(48000 * SECONDS[i])), 48000).arrayBuffer()))
  }
  Object.defineProperty(globalThis, "Audio", { writable: true, configurable: true, value: FakeAudio })
  Object.defineProperty(globalThis.URL, "createObjectURL", { writable: true, configurable: true, value: vi.fn((b: Blob) => { blobs.push(b); return `blob:${blobs.length}` }) })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", { writable: true, configurable: true, value: vi.fn() })
})

const project = { id: "p1" } as unknown as ProjectRecord
// The line as the read hands it over after a LangQuest sync (sync.ts): every
// card selected, the first one the slot's pointer, the rest its pieces.
const attachments = Object.fromEntries(ids.map((id, i) => [id, {
  type: "audio", url: buildFrontierAudioUrl(id, "wav"), slot: "recording", durationMs: SECONDS[i] * 1000,
  label: "LangQuest v1", ...(i > 0 ? { pieceOf: ids[0] } : {}),
}]))
const cell = { metadata: { attachments, selectedAudioId: ids[0] } } as unknown as CodexCell

describe("useCellAudio — a multi-card LangQuest take", () => {
  it.fails("plays every card, one after another, not only the first card's recording", async () => {
    const { result } = renderHook(() => useCellAudio(project, cell, "f1"))
    // The window the rail's player gets for this take (EditorTable).
    const w = takePlayWindow(attachments, ids[0])
    act(() => result.current.setTrim(w?.start ?? null, w?.end ?? null, w?.gaps))
    await act(async () => {
      result.current.play()
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // What it plays: all three cards, 2.1 s of 16-bit samples after one header.
    const total = SECONDS.reduce((a, b) => a + b, 0)
    expect(blobs.at(-1)?.size).toBe(44 + Math.round(total * 48000) * 2)
  })
})
