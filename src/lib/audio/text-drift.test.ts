// AQU-464 — audio↔text drift resolution.

import { describe, it, expect, beforeEach } from "vitest"
import type { CellHistoryEvent } from "@/lib/sync/history-read-types"
import { resolveRecordingTextDrift, resolveRecordingTextDriftMap } from "./text-drift"

let seq = 0
function commit(
  id: string,
  value: string,
  opts: { parentId?: string | null; kind?: string; serverTs?: number } = {},
): CellHistoryEvent {
  seq += 1
  return {
    id,
    parentId: opts.parentId ?? null,
    kind: opts.kind ?? "target.cell.commit",
    author: "u1",
    clientTs: 1000 + seq,
    serverTs: opts.serverTs ?? 1000 + seq,
    serverSeq: seq,
    payload: { value },
  }
}

function attach(id: string, audioId: string, opts: { serverTs?: number } = {}): CellHistoryEvent {
  seq += 1
  return {
    id,
    parentId: null,
    kind: "cell.audio.attach",
    author: "u1",
    clientTs: 1000 + seq,
    serverTs: opts.serverTs ?? 1000 + seq,
    serverSeq: seq,
    payload: { audioId, url: `r2://${audioId}`, slot: "recording" },
  }
}

beforeEach(() => {
  seq = 0
})

describe("resolveRecordingTextDrift", () => {
  it("reports the text as it stood when the take was recorded", () => {
    const events = [
      commit("c1", "In the beginning"),
      attach("a1", "take-1"),
      commit("c2", "At the first", { parentId: "c1" }),
    ]

    const drift = resolveRecordingTextDrift(events, "take-1")

    expect(drift?.textAtRecording).toBe("In the beginning")
    expect(drift?.textAtRecordingEventId).toBe("c1")
    expect(drift?.latestText).toBe("At the first")
    expect(drift?.latestTextEventId).toBe("c2")
    expect(drift?.drifted).toBe(true)
  })

  it("does not flag a take whose text has not changed since", () => {
    const events = [commit("c1", "In the beginning"), attach("a1", "take-1")]

    expect(resolveRecordingTextDrift(events, "take-1")?.drifted).toBe(false)
  })

  it("treats a whitespace-only edit as no drift", () => {
    const events = [
      commit("c1", "In the beginning"),
      attach("a1", "take-1"),
      commit("c2", "  In   the\nbeginning  ", { parentId: "c1" }),
    ]

    expect(resolveRecordingTextDrift(events, "take-1")?.drifted).toBe(false)
  })

  it("does not flag a take recorded before the cell had any text", () => {
    // Nothing to have drifted FROM — the take predates every commit.
    const events = [attach("a1", "take-1"), commit("c1", "In the beginning")]

    const drift = resolveRecordingTextDrift(events, "take-1")

    expect(drift?.textAtRecording).toBeNull()
    expect(drift?.drifted).toBe(false)
  })

  it("orders by serverSeq, not by the recorder's clock", () => {
    // A device with a wrong clock stamps the attach days in the future. It must
    // still resolve against the commit that actually preceded it.
    const c1 = commit("c1", "In the beginning")
    const a1 = attach("a1", "take-1", { serverTs: 1 })
    const c2 = commit("c2", "At the first", { parentId: "c1" })
    a1.clientTs = 9_999_999_999

    const drift = resolveRecordingTextDrift([c1, a1, c2], "take-1")

    expect(drift?.textAtRecording).toBe("In the beginning")
    expect(drift?.drifted).toBe(true)
  })

  it("dates a take by its FIRST attach, not the timings re-attach", () => {
    // Whisper's word timings land on a second cell.audio.attach ~800ms later.
    // Dating the take by that one would move it past a commit made in between
    // and hide a real drift.
    const events = [
      commit("c1", "In the beginning"),
      attach("a1", "take-1"),
      commit("c2", "At the first", { parentId: "c1" }),
      attach("a2", "take-1"),
    ]

    const drift = resolveRecordingTextDrift(events, "take-1")

    expect(drift?.textAtRecordingEventId).toBe("c1")
    expect(drift?.drifted).toBe(true)
  })

  it("returns null when the take has no attach in the history window", () => {
    // "Cannot say" must not render as "no drift".
    const events = [commit("c1", "In the beginning"), attach("a1", "take-1")]

    expect(resolveRecordingTextDrift(events, "take-missing")).toBeNull()
  })

  it("ignores stale-sibling commits when the chain head is known", () => {
    // c2 and c2b both chain off c1; c2 won. The take was recorded after both,
    // so the text at recording is the WINNER, and the losing branch must not
    // manufacture drift.
    const events = [
      commit("c1", "In the beginning"),
      commit("c2", "At the first", { parentId: "c1" }),
      commit("c2b", "A stale branch", { parentId: "c1" }),
      attach("a1", "take-1"),
    ]

    const drift = resolveRecordingTextDrift(events, "take-1", { currentEventId: "c2" })

    expect(drift?.textAtRecording).toBe("At the first")
    expect(drift?.latestText).toBe("At the first")
    expect(drift?.drifted).toBe(false)
  })

  it("reads a media source cell's transcription, not its import filename", () => {
    // AQU-646: a media source commit keeps the filename in `value` and the
    // translatable text in `transcription`.
    const c1 = commit("c1", "luke-01.mp3", { kind: "source.cell.commit" })
    c1.payload = { value: "luke-01.mp3", transcription: "In the beginning" }
    const a1 = attach("a1", "take-1")
    const c2 = commit("c2", "luke-01.mp3", { kind: "source.cell.commit", parentId: "c1" })
    c2.payload = { value: "luke-01.mp3", transcription: "At the first" }

    const drift = resolveRecordingTextDrift([c1, a1, c2], "take-1")

    expect(drift?.textAtRecording).toBe("In the beginning")
    expect(drift?.latestText).toBe("At the first")
    expect(drift?.drifted).toBe(true)
  })

  it("carries the server timestamp as the recording's date stamp", () => {
    const events = [commit("c1", "In the beginning"), attach("a1", "take-1", { serverTs: 1720000000000 })]

    expect(resolveRecordingTextDrift(events, "take-1")?.recordedAt).toBe(1720000000000)
  })

  it("resolves against history returned newest-first", () => {
    // The server returns server_seq DESC; the resolver must not depend on the
    // caller having reversed it.
    const events = [
      commit("c1", "In the beginning"),
      attach("a1", "take-1"),
      commit("c2", "At the first", { parentId: "c1" }),
    ]

    const drift = resolveRecordingTextDrift([...events].reverse(), "take-1")

    expect(drift?.textAtRecording).toBe("In the beginning")
    expect(drift?.drifted).toBe(true)
  })
})

describe("resolveRecordingTextDriftMap", () => {
  it("resolves each take against its own recording moment", () => {
    const events = [
      commit("c1", "In the beginning"),
      attach("a1", "take-1"),
      commit("c2", "At the first", { parentId: "c1" }),
      attach("a2", "take-2"),
    ]

    const map = resolveRecordingTextDriftMap(events, ["take-1", "take-2"])

    expect(map.get("take-1")?.drifted).toBe(true)
    expect(map.get("take-2")?.drifted).toBe(false)
  })

  it("omits takes it cannot place rather than calling them undrifted", () => {
    const events = [commit("c1", "In the beginning"), attach("a1", "take-1")]

    const map = resolveRecordingTextDriftMap(events, ["take-1", "take-unknown"])

    expect(map.has("take-1")).toBe(true)
    expect(map.has("take-unknown")).toBe(false)
  })
})
