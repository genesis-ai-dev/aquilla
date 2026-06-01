// Regression tests for the optimistic-injection path of useFileAudioAttachments.
//
// Bug being guarded: after recording a clip, the gutter mic icon stayed a mic
// (instead of flipping to a play button) until a full page reload. Root cause —
// the recording modal emits cell.audio.attach to the local outbox (returns
// before the server projects it), then poked the read hook to REFETCH the
// server projection, which raced ahead of the projection and read stale.
//
// The fix lets the producer inject the just-created attachment straight into
// the hook's state so the cell reports a selected clip immediately. The editor
// derives `hasAudio` from `selectedAudioId` + `attachments[id]`, so these
// assertions encode WHY the icon flips, not just that the map changed.

import "fake-indexeddb/auto"
import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

// No session → doFetch bails before any network read, isolating the optimistic
// path under test (the gutter must update even when the server hasn't caught up).
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: null, loading: false }),
}))

import { useFileAudioAttachments } from "./useFileAudioAttachments"
import { injectOptimisticAudioAttachment } from "@/lib/audio/audio-attachments-bus"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

function recording(audioId: string): AudioAttachmentOut {
  return {
    audioId, url: `frontier-audio://${audioId}`, slot: "recording",
    mimeType: "audio/webm", voiceId: null, referenceAudioId: null,
    durationMs: null, trimStartMs: null, trimEndMs: null,
  }
}

describe("useFileAudioAttachments — optimistic injection (mic → play after recording)", () => {
  it("surfaces a just-recorded clip as the cell's selected recording, with no server read", () => {
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-1"))
    expect(result.current.byCellId.get("cell-1")).toBeUndefined()

    act(() => {
      injectOptimisticAudioAttachment("file-1", "cell-1", recording("rec-1.webm"))
    })

    const entry = result.current.byCellId.get("cell-1")
    // hasAudio = Boolean(attachments[selectedAudioId] && !isDeleted) — both the
    // selection AND the attachment row must be present, or the mic won't flip.
    expect(entry?.selectedAudioId).toBe("rec-1.webm")
    expect(entry?.attachments["rec-1.webm"]?.url).toBe("frontier-audio://rec-1.webm")
  })

  it("merges into the existing entry, preserving the other slot's selection", () => {
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-2"))

    const tts: AudioAttachmentOut = { ...recording("tts-1.mp3"), slot: "generatedVoice", voiceId: "v1" }
    act(() => { injectOptimisticAudioAttachment("file-2", "cell-9", tts) })
    act(() => { injectOptimisticAudioAttachment("file-2", "cell-9", recording("rec-2.webm")) })

    const entry = result.current.byCellId.get("cell-9")
    expect(entry?.selectedGeneratedVoiceAudioId).toBe("tts-1.mp3") // untouched by the recording inject
    expect(entry?.selectedAudioId).toBe("rec-2.webm")              // recording slot set
    expect(Object.keys(entry?.attachments ?? {})).toHaveLength(2)  // both clips retained
  })

  it("scopes injections to the file id (a poke for another file does nothing)", () => {
    const { result } = renderHook(() => useFileAudioAttachments("proj-1", "file-3"))
    act(() => {
      injectOptimisticAudioAttachment("some-other-file", "cell-1", recording("rec-x.webm"))
    })
    expect(result.current.byCellId.get("cell-1")).toBeUndefined()
  })
})
