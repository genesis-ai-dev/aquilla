/**
 * AQU-1368: the flush-boundary mirror of AQU-927's emit-time `intMs()` guard.
 *
 * These cover the pure repair function. The flush wiring — that a stored
 * record with `durationMs: 2403.5` actually goes out as `2404` — is covered in
 * outbox-flush.test.ts, where a real IDB outbox round-trips the record.
 */

import { describe, it, expect } from "vitest"
import { sanitizeStoredEvent, sanitizeStoredEvents } from "./outbox-sanitize"
import type { CqrsRawEvent } from "./outbox-types"
import { CQRS_SCHEMA_VERSION } from "./outbox-types"

function makeEvent(payload: Record<string, unknown>, clientTs = 1): CqrsRawEvent {
  return {
    id: "01a005c8-816e-7484-906c-e57dd8fb10a6",
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "cell.audio.attach",
    projectId: "proj",
    fileId: "file-1",
    cellId: "cell-1",
    author: "lin184",
    payload,
    clientTs,
  } as unknown as CqrsRawEvent
}

describe("sanitizeStoredEvent", () => {
  it("rounds the exact value from the partner report: durationMs 2403.5 → 2404", () => {
    const event = makeEvent({ audioId: "a1", durationMs: 2403.5 })
    expect(sanitizeStoredEvent(event).payload).toEqual({ audioId: "a1", durationMs: 2404 })
  })

  it("rounds every fractional `…Ms` field, not just durationMs", () => {
    const event = makeEvent({
      startMs: 10.2,
      endMs: 20.8,
      trimStartMs: 1.5,
      trimEndMs: 2.5,
      subtitleStartMs: 3.4,
      subtitleEndMs: 4.6,
      targetOffsetMs: -1.5,
      targetStartMs: 7.49,
    })
    expect(sanitizeStoredEvent(event).payload).toEqual({
      startMs: 10,
      endMs: 21,
      trimStartMs: 2,
      trimEndMs: 3,
      subtitleStartMs: 3,
      subtitleEndMs: 5,
      // Math.round(-1.5) is -1: rounding is half-up, matching intMs() exactly
      // rather than inventing a second rule at this boundary.
      targetOffsetMs: -1,
      targetStartMs: 7,
    })
  })

  it("leaves non-Ms fields alone — seconds are reals and fractions are correct there", () => {
    const event = makeEvent({ startTime: 12.34, value: "v", confidence: 0.75 })
    const out = sanitizeStoredEvent(event)
    expect(out.payload).toEqual({ startTime: 12.34, value: "v", confidence: 0.75 })
    expect(out).toBe(event)
  })

  it("does not match a field that merely contains the letters (msgId)", () => {
    const event = makeEvent({ msgId: 1.5 })
    expect(sanitizeStoredEvent(event).payload).toEqual({ msgId: 1.5 })
  })

  it("returns the SAME object when the event is already clean (no allocation on the hot path)", () => {
    const event = makeEvent({ durationMs: 2404, value: "v" })
    expect(sanitizeStoredEvent(event)).toBe(event)
  })

  it("repairs `…Ms` nested inside objects and arrays of segments", () => {
    const event = makeEvent({
      segments: [{ startMs: 1.5, text: "a" }, { startMs: 3.5, text: "b" }],
      trim: { trimStartMs: 9.9 },
    })
    expect(sanitizeStoredEvent(event).payload).toEqual({
      segments: [{ startMs: 2, text: "a" }, { startMs: 4, text: "b" }],
      trim: { trimStartMs: 10 },
    })
  })

  it("leaves NaN/Infinity alone — rounding produces another value the column refuses", () => {
    const event = makeEvent({ durationMs: Number.NaN, endMs: Number.POSITIVE_INFINITY })
    const out = sanitizeStoredEvent(event)
    const payload = out.payload as unknown as { durationMs: number; endMs: number }
    expect(Number.isNaN(payload.durationMs)).toBe(true)
    expect(payload.endMs).toBe(Number.POSITIVE_INFINITY)
  })

  it("leaves a string `…Ms` alone rather than coercing it to a number", () => {
    const event = makeEvent({ durationMs: "2403.5" })
    expect(sanitizeStoredEvent(event).payload).toEqual({ durationMs: "2403.5" })
  })

  it("rounds a fractional clientTs, which lands in a bigint column too", () => {
    const event = makeEvent({ value: "v" }, 1_700_000_000_000.5)
    expect(sanitizeStoredEvent(event).clientTs).toBe(1_700_000_000_001)
  })

  it("does not mutate the stored record it was handed", () => {
    const payload = { durationMs: 2403.5 }
    const event = makeEvent(payload)
    sanitizeStoredEvent(event)
    expect(payload.durationMs).toBe(2403.5)
    expect(event.payload).toBe(payload)
  })

  it("sanitizeStoredEvents keeps order and repairs only the poisoned member", () => {
    const clean = makeEvent({ durationMs: 1000 })
    const poison = makeEvent({ durationMs: 2403.5 })
    const out = sanitizeStoredEvents([clean, poison])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(clean)
    expect(out[1].payload).toEqual({ durationMs: 2404 })
  })
})
