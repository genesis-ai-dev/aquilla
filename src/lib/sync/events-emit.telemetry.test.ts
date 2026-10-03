/**
 * AQU-1572: per-gesture validation + audio telemetry at the emit seam.
 *
 * Every assertion here is "one gesture, one event" — the gap the ticket
 * describes was not that validation was unmeasured in principle but that the
 * only validation event in the catalogue (`first cell validate`) fires once
 * per session, so it cannot tell "one person validated once" from "a team
 * validated a thousand cells".
 *
 * Mirrors the mocking in `event-names.test.ts`: posthog and the outbox are both
 * mocked, so nothing touches the network or IDB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }))

vi.mock("@/lib/posthog", () => ({
  default: {
    capture: mockCapture,
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}))

vi.mock("./outbox", () => ({
  enqueueOutboxEvent: vi.fn().mockResolvedValue(undefined),
  enqueueOutboxEvents: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("./cqrs-bridge", () => ({
  getCqrsOutboxBridge: vi.fn().mockReturnValue(null),
}))

vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: vi.fn().mockReturnValue("http://localhost:8787"),
}))

import {
  AUDIO_ATTACHED,
  AUDIO_GENERATED,
  AUDIO_RECORDED,
  CELL_UNVALIDATED,
  CELL_VALIDATED,
} from "@/lib/event-names"
import {
  emitCellAudioAttach,
  emitCellAudioUnvalidate,
  emitCellAudioValidate,
  emitCellUnvalidate,
  emitCellValidate,
} from "./events-emit"

/** Every capture() call made with `name`, as its property bag. */
function captured(name: string): Record<string, unknown>[] {
  return mockCapture.mock.calls
    .filter((args) => args[0] === name)
    .map((args) => args[1] as Record<string, unknown>)
}

const CELL = { projectId: "p1", fileId: "f1", cellId: "c1", author: "tester" }

beforeEach(() => {
  mockCapture.mockClear()
})

describe("text validation telemetry", () => {
  it("emits one `cell validated` with medium=text per validate gesture", async () => {
    await emitCellValidate({ ...CELL, editEventId: "ev1", targetLang: "spa" })

    const events = captured(CELL_VALIDATED)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      medium: "text",
      project_id: "p1",
      file_id: "f1",
      cell_id: "c1",
      lane: "spa",
      source: "ui",
    })
  })

  it("keeps firing after the once-per-session milestone has been spent", async () => {
    // The whole point of the ticket: `first cell validate` is a milestone and
    // stops; this one must not.
    await emitCellValidate({ ...CELL, editEventId: "ev1" })
    mockCapture.mockClear()
    await emitCellValidate({ ...CELL, cellId: "c2", editEventId: "ev2" })

    expect(captured(CELL_VALIDATED)).toHaveLength(1)
  })

  it("reports the default lane as an empty lane rather than omitting it", async () => {
    await emitCellValidate({ ...CELL, editEventId: "ev1" })
    expect(captured(CELL_VALIDATED)[0]).toMatchObject({ lane: "" })
  })

  it("emits `cell unvalidated` for the mirror gesture", async () => {
    await emitCellUnvalidate({ ...CELL, editEventId: "ev1", targetLang: "spa" })

    expect(captured(CELL_VALIDATED)).toHaveLength(0)
    expect(captured(CELL_UNVALIDATED)).toHaveLength(1)
    expect(captured(CELL_UNVALIDATED)[0]).toMatchObject({ medium: "text", lane: "spa" })
  })

  it("carries source=agent when the in-app agent applies a draft review", async () => {
    await emitCellValidate({ ...CELL, editEventId: "ev1", source: "agent" })
    expect(captured(CELL_VALIDATED)[0]).toMatchObject({ source: "agent" })
  })

  it("never puts the telemetry-only `source` on the wire payload", async () => {
    const { enqueueOutboxEvent } = await import("./outbox")
    vi.mocked(enqueueOutboxEvent).mockClear()
    await emitCellValidate({ ...CELL, editEventId: "ev1", source: "agent" })

    const enqueued = vi.mocked(enqueueOutboxEvent).mock.calls[0][0] as {
      payload: Record<string, unknown>
    }
    expect(enqueued.payload).not.toHaveProperty("source")
  })
})

describe("audio validation telemetry", () => {
  it("emits `cell validated` with medium=audio", async () => {
    await emitCellAudioValidate({ ...CELL, audioId: "a1.wav", targetLang: "spa" })

    expect(captured(CELL_VALIDATED)).toHaveLength(1)
    expect(captured(CELL_VALIDATED)[0]).toMatchObject({ medium: "audio", lane: "spa" })
  })

  it("emits `cell unvalidated` with medium=audio for a withdrawn vote", async () => {
    await emitCellAudioUnvalidate({ ...CELL, audioId: "a1.wav" })

    expect(captured(CELL_UNVALIDATED)).toHaveLength(1)
    expect(captured(CELL_UNVALIDATED)[0]).toMatchObject({ medium: "audio" })
  })
})

describe("automatic votes (AQU-1572)", () => {
  // The vote your own edit casts for itself, and the recorder's vote for its
  // fresh take, fire on every saved edit and every take. They are still sent,
  // so the totals stay true, but marked, so "how much reviewing happened"
  // can leave them out with one filter.
  it("marks a text validation the app cast by itself as auto", async () => {
    await emitCellValidate({ ...CELL, editEventId: "ev1", auto: true })
    expect(captured(CELL_VALIDATED)).toEqual([expect.objectContaining({ auto: true })])
  })

  it("marks the recorder's vote for its own take as auto", async () => {
    await emitCellAudioValidate({ ...CELL, audioId: "a1.wav", auto: true })
    expect(captured(CELL_VALIDATED)).toEqual([expect.objectContaining({ medium: "audio", auto: true })])
  })

  it("reports every other validation as auto: false, never leaving it out", async () => {
    await emitCellValidate({ ...CELL, editEventId: "ev1" })
    await emitCellUnvalidate({ ...CELL, editEventId: "ev1" })
    await emitCellAudioValidate({ ...CELL, audioId: "a1.wav" })
    await emitCellAudioUnvalidate({ ...CELL, audioId: "a1.wav" })
    const all = [...captured(CELL_VALIDATED), ...captured(CELL_UNVALIDATED)]
    expect(all).toHaveLength(4)
    for (const props of all) expect(props.auto).toBe(false)
  })
})

describe("telemetry-only inputs never reach the wire (AQU-1572)", () => {
  // Every field a validation emit takes only for telemetry, set at once. The
  // payload each one queues must be exactly what it was before telemetry
  // existed, so the server, the event log and every other client see no
  // difference.
  const TELEMETRY_ONLY = { source: "agent", auto: true } as const

  async function payloadOf(emit: () => Promise<unknown>): Promise<Record<string, unknown>> {
    const { enqueueOutboxEvent } = await import("./outbox")
    vi.mocked(enqueueOutboxEvent).mockClear()
    await emit()
    return (vi.mocked(enqueueOutboxEvent).mock.calls[0][0] as { payload: Record<string, unknown> }).payload
  }

  it("text validate and unvalidate queue only the edit and the lane", async () => {
    for (const emit of [emitCellValidate, emitCellUnvalidate]) {
      const payload = await payloadOf(() => emit({ ...CELL, editEventId: "ev1", targetLang: "spa", ...TELEMETRY_ONLY }))
      expect(payload).toEqual({ editEventId: "ev1", targetLang: "spa" })
    }
  })

  it("audio validate and unvalidate queue only the take and the lane", async () => {
    for (const emit of [emitCellAudioValidate, emitCellAudioUnvalidate]) {
      const payload = await payloadOf(() => emit({ ...CELL, audioId: "a1.wav", targetLang: "spa", ...TELEMETRY_ONLY }))
      expect(Object.keys(payload).sort()).toEqual(["audioId", "targetLang"])
    }
  })
})

describe("audio action telemetry", () => {
  const ATTACH = { ...CELL, audioId: "a1.wav", url: "frontier-audio://a1.wav", slot: "recording" }

  it("emits `audio attached` for an upload / LinkMedia attach", async () => {
    await emitCellAudioAttach({ ...ATTACH, audioOrigin: "attach", durationMs: 1234.6 })

    expect(captured(AUDIO_ATTACHED)).toHaveLength(1)
    expect(captured(AUDIO_ATTACHED)[0]).toMatchObject({
      project_id: "p1",
      cell_id: "c1",
      slot: "recording",
      duration_ms: 1235,
      source: "ui",
    })
  })

  it("emits `audio generated` with the voice and provider for a synthesis", async () => {
    await emitCellAudioAttach({
      ...ATTACH,
      slot: "generatedVoice",
      audioOrigin: "generate",
      voiceId: "voice-7",
      ttsProvider: "inworld",
      durationMs: 900,
    })

    expect(captured(AUDIO_GENERATED)).toHaveLength(1)
    expect(captured(AUDIO_GENERATED)[0]).toMatchObject({
      slot: "generatedVoice",
      voice_id: "voice-7",
      provider: "inworld",
      duration_ms: 900,
    })
    expect(captured(AUDIO_ATTACHED)).toHaveLength(0)
  })

  it("emits `audio recorded` for a take saved from the recorder", async () => {
    await emitCellAudioAttach({ ...ATTACH, audioOrigin: "record" })

    expect(captured(AUDIO_RECORDED)).toHaveLength(1)
    expect(captured(AUDIO_ATTACHED)).toHaveLength(0)
    expect(captured(AUDIO_GENERATED)).toHaveLength(0)
  })

  it("emits nothing for a derived re-attach (denoise, timings, diarization, heal)", async () => {
    // These re-attach a clip that the originating gesture already counted.
    // They pass no origin, so counting them again is impossible by construction.
    await emitCellAudioAttach(ATTACH)

    expect(captured(AUDIO_ATTACHED)).toHaveLength(0)
    expect(captured(AUDIO_GENERATED)).toHaveLength(0)
    expect(captured(AUDIO_RECORDED)).toHaveLength(0)
  })

  it("never puts the telemetry-only fields on the wire payload", async () => {
    const { enqueueOutboxEvent } = await import("./outbox")
    vi.mocked(enqueueOutboxEvent).mockClear()
    await emitCellAudioAttach({
      ...ATTACH,
      audioOrigin: "generate",
      ttsProvider: "inworld",
      source: "ui",
    })

    const enqueued = vi.mocked(enqueueOutboxEvent).mock.calls[0][0] as {
      payload: Record<string, unknown>
    }
    expect(enqueued.payload).not.toHaveProperty("audioOrigin")
    expect(enqueued.payload).not.toHaveProperty("ttsProvider")
    expect(enqueued.payload).not.toHaveProperty("source")
  })
})
