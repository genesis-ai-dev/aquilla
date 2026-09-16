// The walk over a project's files. (AQU-646, 2026-08-19)
//
// The builders are tested purely next door; what needs pinning here is the
// gathering — that the cue sibling's RECORDINGS are merged in (without them
// every character reads as unrecorded), that one unreadable episode does not
// take the report down with it, and that an episode which cannot be read is
// reported rather than quietly missing.

import { describe, expect, it, vi } from "vitest"

import { runProjectReport, type RunProjectReportArgs } from "./project-report-run"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { CueLink } from "@/lib/sync/cell-links-read"

const row = (id: string, over: Partial<CellRow> = {}): CellRow =>
  ({
    cellId: id,
    value: `line ${id}`,
    startMs: 1000,
    endMs: 2000,
    ...over,
  }) as CellRow

const audioEntry = (audioId: string): CellAudioEntry =>
  ({
    selectedAudioId: audioId,
    attachments: { [audioId]: { url: `frontier-audio://${audioId}.wav`, durationMs: 900 } },
  }) as unknown as CellAudioEntry

function harness(over: Partial<RunProjectReportArgs> = {}): RunProjectReportArgs {
  return {
    projectId: "p1",
    projectName: "The Chosen",
    files: [{ id: "text-1", name: "Episode 1", siblingId: "cues-1" }],
    settings: { voices: [{ id: "v", name: "Voice" }], castAssignments: {} },
    getToken: async () => "token",
    fetchCells: async (_p, fileId) =>
      fileId === "cues-1" ? [row("q1"), row("q2")] : [row("s1"), row("s2")],
    fetchAudio: async () => ({ cells: { q1: audioEntry("take-1") } }),
    fetchLinks: async () => ({ links: [] as CueLink[] }),
    ...over,
  }
}

describe("gathering one project", () => {
  it("reports a section per file, in the order given", async () => {
    const { data } = await runProjectReport(
      harness({
        files: [
          { id: "a", name: "Episode 1" },
          { id: "b", name: "Episode 2" },
        ],
      }),
    )
    expect(data.files.map((f) => f.fileName)).toEqual(["Episode 1", "Episode 2"])
    expect(data.projectName).toBe("The Chosen")
  })

  it("merges the sibling's recordings, so progress is not uniformly zero", async () => {
    // THE BUG THIS GUARDS. A raw cell read carries no attachments; without the
    // merge every character in every episode would be reported as having
    // nothing recorded, and the report would be confidently wrong.
    const { data } = await runProjectReport(harness())
    expect(data.files[0]!.progress.recorded).toBe(1)
  })

  it("asks for nothing from a file with no sibling, and still reports it", async () => {
    const fetchCells = vi.fn(async () => [row("s1")])
    const { data } = await runProjectReport(
      harness({ files: [{ id: "text-1", name: "Episode 1", siblingId: null }], fetchCells }),
    )
    expect(fetchCells).toHaveBeenCalledTimes(1)
    expect(data.files[0]!.pairing.cues).toBe(0)
  })

  it("carries the recorded timebase into the section", async () => {
    const { data } = await runProjectReport(
      harness({
        files: [{ id: "text-1", name: "Episode 1", siblingId: "cues-1", timebase: { fromFps: "24", toFps: "23.976", scale: 1.001 } }],
      }),
    )
    expect(data.files[0]!.timebase.kind).toBe("corrected")
  })
})

describe("a project where something will not read", () => {
  it("keeps going and names the file it could not read", async () => {
    const { data, unreadable } = await runProjectReport(
      harness({
        files: [
          { id: "good", name: "Episode 1" },
          { id: "bad", name: "Episode 2" },
        ],
        fetchCells: async (_p, fileId) => {
          if (fileId === "bad") throw new Error("500 from the server")
          return [row("s1")]
        },
      }),
    )
    expect(data.files.map((f) => f.fileName)).toEqual(["Episode 1"])
    expect(unreadable).toEqual([{ fileName: "Episode 2", reason: "500 from the server" }])
  })

  it("treats a file it has no token for as unreadable rather than empty", async () => {
    // An episode reported as clean because we could not open it is the worst
    // possible answer from a health report.
    const { unreadable } = await runProjectReport(
      harness({ getToken: async () => null }),
    )
    expect(unreadable[0]!.reason).toMatch(/no access/i)
  })

  it("survives a sibling whose audio or links cannot be read", async () => {
    // Degraded, not fatal: the characters and the cues are still worth having.
    const { data, unreadable } = await runProjectReport(
      harness({
        fetchAudio: async () => { throw new Error("audio route down") },
        fetchLinks: async () => { throw new Error("links route down") },
      }),
    )
    expect(unreadable).toEqual([])
    expect(data.files[0]!.pairing.cues).toBe(2)
    expect(data.files[0]!.progress.recorded).toBe(0)
  })
})

describe("progress reporting", () => {
  it("counts files, naming the one being read", async () => {
    const seen: string[] = []
    await runProjectReport(
      harness({
        files: [{ id: "a", name: "Episode 1" }, { id: "b", name: "Episode 2" }],
        onProgress: (done, total, name) => seen.push(`${done}/${total} ${name}`),
      }),
    )
    expect(seen[0]).toBe("0/2 Episode 1")
    expect(seen.at(-1)).toBe("2/2 Episode 2")
  })
})
