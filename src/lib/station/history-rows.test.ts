import { describe, expect, it } from "vitest"
import { draftRows, historyRowsFromEvents, historyWhen } from "./history-rows"

const ev = (serverSeq: number, kind: string, payload: object, author = "ana") => ({
  id: `e${serverSeq}`,
  parentId: null,
  kind,
  author,
  clientTs: serverSeq * 1000,
  serverTs: serverSeq * 1000,
  serverSeq,
  payload,
})

describe("the Station's History rows", () => {
  it("tells one recording's story oldest first, with who did it", () => {
    const rows = historyRowsFromEvents(
      [
        ev(4, "cell.audio.validate", { audioId: "t2" }, "rita"),
        ev(1, "cell.audio.attach", { audioId: "t2" }),
        ev(2, "cell.audio.trim", { audioId: "t2", trimStartMs: 250, trimEndMs: null }),
        ev(3, "cell.audio.trim", { audioId: "other", trimStartMs: 0, trimEndMs: 10 }),
        ev(5, "cell.audio.attach", { audioId: "t2v2", referenceAudioId: "t2" }),
      ],
      new Set(["t2", "t2v2"]),
      { durationSec: 4.2, versionOf: () => 2 },
    )
    expect(rows.map((r) => r.key)).toEqual([
      "editor.station.hRecorded",
      "editor.station.hTrimmed",
      "editor.station.hApproved",
      "editor.station.hVersionSaved",
    ])
    expect(rows[1].params).toEqual({ a: "0:00.25", b: "0:04.20" })
    expect(rows[2].who).toBe("rita")
  })

  it("names an earlier version's open end from that version's own length", () => {
    const rows = historyRowsFromEvents(
      [
        ev(1, "cell.audio.trim", { audioId: "t2", trimStartMs: 400, trimEndMs: null }),
        ev(2, "cell.audio.attach", { audioId: "t2v2", referenceAudioId: "t2" }),
        ev(3, "cell.audio.trim", { audioId: "t2v2", trimStartMs: 200, trimEndMs: null }),
      ],
      new Set(["t2", "t2v2"]),
      { durationSec: 4.3, durationOf: (id) => (id === "t2" ? 4.2 : 4.3), versionOf: () => 2 },
    )
    expect(rows[0].params).toEqual({ a: "0:00.40", b: "0:04.20" })
    expect(rows[2].params).toEqual({ a: "0:00.20", b: "0:04.30" })
  })

  it("numbers the unsaved edits", () => {
    const rows = draftRows([
      { kind: "del", a: 1, b: 1.5 },
      { kind: "ins", at: 1.75, src: "x", len: 0.6, label: "Room tone, camp" },
    ])
    expect(rows[0].params).toEqual({ n: 1, len: "0.50 s", time: "0:01.00" })
    expect(rows[1].params).toMatchObject({ n: 2, label: "Room tone, camp" })
  })

  it("says the time today and the day before that", () => {
    const now = new Date(2026, 9, 30, 15, 0).getTime()
    expect(historyWhen(new Date(2026, 9, 30, 14, 14).getTime(), "en-US", now)).toMatch(/2:14/)
    expect(historyWhen(new Date(2026, 9, 28, 14, 14).getTime(), "en-US", now)).toMatch(/Oct 28, 2:14/)
  })
})
