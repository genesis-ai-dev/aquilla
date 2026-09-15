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
import { exportCsv } from "./csv"
import { exportTsv } from "./tsv"
import { exportXliff12Structured } from "./xliff12-structured"
import { exportTmxStructured } from "./tmx-structured"
import { buildLegacyGroups } from "./docx"
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

/**
 * AQU-1068: the same question, asked of every exporter an added line can
 * actually reach.
 *
 * The import sweep found that no hazard here lives in the INSERT — the insert
 * is the same anchor operation on every file type. They all live in the export,
 * which asks whether the client's format can receive a cell that was born in
 * the app. So the rule for the round: an exporter either handles an added line
 * honestly or its file type is excluded from inserts, and a SILENT DROP is
 * never acceptable.
 *
 * These cases pin each exporter's answer so a future change has to state its
 * intent rather than quietly alter one.
 */
describe("added lines across the reachable exporters", () => {
  const translatedAdded = added({ id: "01890000-0000-7000-8000-00000000aaaa", translated: "added text" })
  const imported = cell({ id: "imp", group: "GEN 1:1", original: "source", translated: "done" })

  describe("row and catalog formats — an added line is ordinary content", () => {
    it("csv emits it under its own id, since it has no ref to be keyed by", async () => {
      const out = await text(exportCsv([imported, translatedAdded]))
      expect(out).toContain("added text")
      expect(out).toContain(translatedAdded.id)
    })

    it("tsv likewise", async () => {
      const out = await text(exportTsv([imported, translatedAdded]))
      expect(out).toContain("added text")
      expect(out).toContain(translatedAdded.id)
    })

    it("xliff gives each added line a UNIQUE unit id", async () => {
      // The bug this pins: an added line's `group` is the empty STRING, and the
      // id expression used `??`, which does not fall through on "". Every added
      // line landed on the id "" and the de-duper renamed them "", "-2", "-3"…
      const second = added({ id: "01890000-0000-7000-8000-00000000bbbb", translated: "another" })
      const out = await text(exportXliff12Structured([translatedAdded, second], "en", "fr"))
      expect(out).toContain(`id="${translatedAdded.id}"`)
      expect(out).toContain(`id="${second.id}"`)
      expect(out).not.toContain('id=""')
    })

    it("tmx carries it once both sides have text", async () => {
      const out = await text(exportTmxStructured(
        [cell({ id: "x", original: "src", translated: "tgt" }),
         added({ id: "y", original: "new src", translated: "new tgt" })],
        "en", "fr",
      ))
      expect(out).toContain("new tgt")
    })
  })

  describe("document formats — an added line has no home in the original", () => {
    // These substitute translations INTO the client's own file. A cell born in
    // the app has no paragraph to substitute into, so its absence is correct —
    // what matters is that it does not disturb the cells that do.
    it("docx does not let an added line shift the positional mapping", () => {
      // The hazard: the legacy locator-less path maps cells to paragraphs BY
      // POSITION, so a cell consuming a slot writes every later translation
      // into the wrong paragraph of the client's document.
      const withAdded = buildLegacyGroups([
        cell({ id: "p1", translated: "one" }),
        added({ id: "ins", translated: "inserted" }),
        cell({ id: "p2", translated: "two" }),
      ])
      const without = buildLegacyGroups([
        cell({ id: "p1", translated: "one" }),
        cell({ id: "p2", translated: "two" }),
      ])
      expect(withAdded.groups).toEqual(without.groups)
    })
  })
})
