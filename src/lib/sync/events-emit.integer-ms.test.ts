// AQU-927 regression guard: every millisecond value that reaches a Postgres
// BIGINT column must leave the emit boundary as an integer.
//
// A `/events` flush is applied as ONE batch, so a single fractional ms value
// (e.g. a denoise duration of 2403.5) made Postgres reject *every* event in
// that flush — which is how whole groups of cells silently lost their uploaded
// audio on refresh. Producers round at the source; this asserts the emit
// boundary rounds too, so one un-rounded producer can never poison a batch.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./cqrs-bridge", () => ({ getCqrsOutboxBridge: () => null }))
vi.mock("./outbox", () => ({ enqueueOutboxEvent: vi.fn(async () => {}) }))

import {
  intMs,
  emitCellAudioAttach,
  emitCellAudioMeasure,
  emitCellRetime,
  emitCellLaneRetime,
  emitSourceCellCreate,
} from "./events-emit"
import { enqueueOutboxEvent } from "./outbox"

const mockEnqueue = enqueueOutboxEvent as unknown as ReturnType<typeof vi.fn>
beforeEach(() => mockEnqueue.mockClear())

function lastPayload(): Record<string, unknown> {
  const ev = mockEnqueue.mock.calls.at(-1)![0] as { payload: Record<string, unknown> }
  return ev.payload
}

/** Every ms value in the payload must be a safe integer. */
function expectIntegerMs(payload: Record<string, unknown>) {
  for (const [key, value] of Object.entries(payload)) {
    if (!/Ms$/.test(key) || typeof value !== "number") continue
    expect(Number.isInteger(value), `${key} = ${value} is not an integer`).toBe(true)
  }
}

describe("intMs", () => {
  it("rounds fractional milliseconds", () => {
    expect(intMs(2403.5)).toBe(2404)
    expect(intMs(9586.938)).toBe(9587)
    expect(intMs(-0.4)).toBe(-0)
  })

  it("leaves integers, null and undefined untouched", () => {
    expect(intMs(4180)).toBe(4180)
    expect(intMs(null)).toBeNull()
    expect(intMs(undefined)).toBeUndefined()
  })

  it("passes non-finite values through so downstream guards still reject them", () => {
    expect(intMs(Number.NaN)).toBeNaN()
    expect(intMs(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("emit boundary rounds ms headed for BIGINT columns", () => {
  it("cell.audio.attach — duration and trim window (the denoise repro)", async () => {
    await emitCellAudioAttach({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      audioId: "dn-c1.webm",
      url: "https://cdn/a.webm",
      slot: "recording",
      durationMs: 2403.5,
      trimStartMs: 120.25,
      trimEndMs: 9586.938,
      author: "u",
    })
    const payload = lastPayload()
    expect(payload.durationMs).toBe(2404)
    expect(payload.trimStartMs).toBe(120)
    expect(payload.trimEndMs).toBe(9587)
    expectIntegerMs(payload)
  })

  it("cell.audio.measure — duration backfill", async () => {
    await emitCellAudioMeasure({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      audioId: "a1",
      durationMs: 4180.7,
      author: "u",
    })
    expect(lastPayload().durationMs).toBe(4181)
  })

  it("cell.retime — segment bounds", async () => {
    await emitCellRetime({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      startMs: 400.4,
      endMs: 6000.6,
      author: "u",
    })
    expect(lastPayload()).toEqual({ startMs: 400, endMs: 6001 })
  })

  it("cell.lane.retime — per-lane presentation timing", async () => {
    await emitCellLaneRetime({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      subtitleStartMs: 1200.5,
      subtitleEndMs: 3400.2,
      targetStartMs: null,
      author: "u",
    })
    const payload = lastPayload()
    expect(payload.subtitleStartMs).toBe(1201)
    expect(payload.subtitleEndMs).toBe(3400)
    expect(payload.targetStartMs).toBeNull()
  })

  it("source.cell.create — importer timeline bounds", async () => {
    await emitSourceCellCreate({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      anchorCellId: null,
      value: "hello",
      startMs: 0.5,
      endMs: 1999.5,
      author: "u",
    })
    const payload = lastPayload()
    expect(payload.startMs).toBe(1)
    expect(payload.endMs).toBe(2000)
  })

  it("leaves already-integer values byte-identical", async () => {
    await emitCellAudioAttach({
      projectId: "p1",
      fileId: "f1",
      cellId: "c1",
      audioId: "a1",
      url: "https://cdn/a.webm",
      slot: "recording",
      durationMs: 4180,
      author: "u",
    })
    expect(lastPayload().durationMs).toBe(4180)
  })
})
