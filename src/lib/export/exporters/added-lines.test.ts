/**
 * AQU-646: what the subtitle exporters owe a line somebody ADDED into a
 * silence, as opposed to a cue that arrived with the import.
 *
 * Two promises, both of which the exporters broke:
 *
 *   - Cues come out in TIME order. The exporters are handed anchor-chain
 *     order, which drifts from the clock the moment anyone retimes a cue —
 *     and, before the mid-file re-point fix, put every added line at the tail.
 *   - An added line keeps its cue even with nothing written in it yet. It may
 *     carry a recording, and its timing is real work either way. Sam settled
 *     the payload on 2026-08-12: a blank text line, never a placeholder.
 *
 * The distinction that makes the second safe: an IMPORTED cue with no text is
 * an untranslated line and is still skipped. Only `aquillaOrigin` earns a
 * blank cue.
 */

import { describe, it, expect } from "vitest"
import { exportVtt } from "./vtt"
import { exportSrt } from "./srt"
import { userLineOrigin } from "@/lib/timeline/user-lines"
import type { CellData } from "@/hooks/useCells"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  } as CellData
}

/** A line someone added into a silence: the origin marker is the whole signal. */
const added = (over: Partial<CellData>) =>
  cell({ metadata: { aquillaOrigin: userLineOrigin() }, ...over })

const text = (b: Blob) => b.text()

describe("subtitle export — time order", () => {
  it("sorts cues by start time, whatever order the cells arrive in", async () => {
    // Chain order with the newest line last is exactly what a mid-file insert
    // used to hand us.
    const cells = [
      cell({ id: "a", translated: "first", startTime: 1, endTime: 2 }),
      cell({ id: "c", translated: "third", startTime: 30, endTime: 31 }),
      cell({ id: "b", translated: "second", startTime: 10, endTime: 11 }),
    ]
    const out = await text(exportVtt(cells, undefined))
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"))
    expect(out.indexOf("second")).toBeLessThan(out.indexOf("third"))
  })

  it("numbers SRT cues sequentially AFTER sorting, not before", async () => {
    const cells = [
      cell({ id: "b", translated: "second", startTime: 10, endTime: 11 }),
      cell({ id: "a", translated: "first", startTime: 1, endTime: 2 }),
    ]
    const out = await text(exportSrt(cells))
    expect(out).toMatch(/^1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n2\n/)
  })

  it("keeps document order for cues that start at the same second", async () => {
    // Two speakers at once is legal in a real VTT; a stable sort must not
    // reshuffle them.
    const cells = [
      cell({ id: "a", translated: "left", startTime: 5, endTime: 6 }),
      cell({ id: "b", translated: "right", startTime: 5, endTime: 6 }),
    ]
    const out = await text(exportVtt(cells, undefined))
    expect(out.indexOf("left")).toBeLessThan(out.indexOf("right"))
  })
})

describe("subtitle export — a line added into a silence", () => {
  it("keeps its cue and its timing with nothing written in it yet", async () => {
    const out = await text(exportVtt([added({ id: "x", startTime: 4, endTime: 6 })], undefined))
    expect(out).toContain("00:00:04.000 --> 00:00:06.000")
    // The payload line is present and blank — not a placeholder, and not gone.
    expect(out).toBe("WEBVTT\n\n00:00:04.000 --> 00:00:06.000\n\n")
  })

  it("does the same in SRT, still numbered", async () => {
    const out = await text(exportSrt([added({ id: "x", startTime: 4, endTime: 6 })]))
    expect(out).toBe("1\n00:00:04,000 --> 00:00:06,000\n\n")
  })

  it("an IMPORTED cue with no text is still skipped", async () => {
    // The line that keeps this honest: a blank imported cue is an
    // untranslated line, not a deliberately silent one.
    const imported = cell({ id: "i", startTime: 4, endTime: 6, metadata: { aquillaImport: { version: 1 } } })
    expect(await text(exportVtt([imported], undefined))).toBe("WEBVTT\n")
    expect(await text(exportSrt([imported]))).toBe("")
  })

  it("still shows text once somebody writes some", async () => {
    const out = await text(exportVtt([added({ id: "x", translated: "Hola", startTime: 4, endTime: 6 })], undefined))
    expect(out).toContain("Hola")
  })

  it("sits in the right place among real cues, blank and all", async () => {
    const cells = [
      cell({ id: "a", translated: "before", startTime: 1, endTime: 2 }),
      cell({ id: "c", translated: "after", startTime: 30, endTime: 31 }),
      added({ id: "x", startTime: 10, endTime: 11 }),
    ]
    const out = await text(exportVtt(cells, undefined))
    const blankCue = out.indexOf("00:00:10.000")
    expect(out.indexOf("before")).toBeLessThan(blankCue)
    expect(blankCue).toBeLessThan(out.indexOf("after"))
  })

  it("an added line with no TIMING is still skipped — a cue needs a clock", async () => {
    expect(await text(exportVtt([added({ id: "x" })], undefined))).toBe("WEBVTT\n")
  })
})
