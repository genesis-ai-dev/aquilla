// The report Anna reads on Monday. (AQU-646, 2026-08-19)
//
// The assertions that matter most here are the ones about a CLEAN episode. A
// report that quietly omits the section it had nothing to say about looks
// identical to a report whose check never ran, and the whole point of the
// document is that it is the record of the checks HAVING run — so the
// all-clear cases below are load-bearing, not filler.

import { describe, it, expect } from "vitest"

import {
  buildFileSection,
  findNameVariants,
  renderProjectReport,
  type ReportFileInput,
  type ReportFileSection,
} from "./project-report"
import type { CellData } from "@/hooks/useCells"
import {
  buildCueLinkIndex,
  EMPTY_CUE_LINK_INDEX,
  type CueLink,
} from "@/lib/sync/cell-links-read"
import { resolutionKey } from "@/lib/timeline/character-agreement"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c",
    fileId: "f",
    original: "",
    translated: "",
    context: "",
    group: "",
    type: "cue",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...over,
  }
}

/** A cell the character sheet has named. */
const named = (id: string, castName: string, over: Partial<CellData> = {}): CellData =>
  cell({ id, metadata: { cast_name: castName }, ...over })

/** The bits of a cell that make it look recorded. */
const take = (id: string): Partial<CellData> => ({
  selectedAudioId: `a-${id}`,
  attachments: { [`a-${id}`]: { url: `frontier-audio://${id}.webm`, type: "audio/webm" } },
})

const edge = (textCellId: string, cueCellId: string): CueLink => ({
  kind: "text-audio",
  fromFileId: "f-subs",
  fromCellId: textCellId,
  toFileId: "f-cues",
  toCellId: cueCellId,
  origin: "auto",
  confidence: 1,
})

const input = (over: Partial<ReportFileInput> = {}): ReportFileInput => ({
  fileId: "f-subs",
  fileName: "Episode 101",
  textCells: [],
  cueCells: [],
  links: EMPTY_CUE_LINK_INDEX,
  settings: undefined,
  ...over,
})

describe("what a file's section says about the two character sheets", () => {
  it("lists the lines the two sheets name differently", () => {
    const section = buildFileSection(
      input({
        textCells: [named("s1", "JESUS")],
        cueCells: [named("c1", "MARY", { original: "Rabbi." })],
        links: buildCueLinkIndex([edge("s1", "c1")]),
      }),
    )
    expect(section.characters.open).toHaveLength(1)
    expect(section.characters.open[0].name).toEqual({
      kind: "character",
      subtitle: "JESUS",
      audio: "MARY",
    })
    expect(section.characters.open[0].heard).toBe("Rabbi.")
  })

  it("counts the lines already settled and the shared rows, rather than listing them as work", () => {
    // A subtitle row serving two cues cannot have one right answer, and a line
    // somebody already decided is not a decision anyone has to make again —
    // both are worth a number in the report and neither is a to-do.
    const section = buildFileSection(
      input({
        textCells: [named("s1", "ANDREW"), named("s2", "SIMON")],
        cueCells: [
          named("c1", "ANDREW", { original: "Good." }),
          named("c2", "SIMON", { original: "Good." }),
          named("c3", "SIMON", { original: "Come." }),
        ],
        links: buildCueLinkIndex([edge("s1", "c1"), edge("s1", "c2"), edge("s2", "c3")]),
        resolutions: {
          [resolutionKey("s2", "c3")]: {
            name: { chose: "audio", rejected: "ANDREW" },
            at: 1000,
          },
        },
      }),
    )
    expect(section.characters.open).toEqual([])
    expect(section.characters.sharedRows).toBe(2)
    expect(section.characters.resolvedCount).toBe(1)
  })

  it("reports an empty list of disagreements rather than nothing at all", () => {
    const section = buildFileSection(
      input({
        textCells: [named("s1", "JESUS")],
        cueCells: [named("c1", "JESUS")],
        links: buildCueLinkIndex([edge("s1", "c1")]),
      }),
    )
    expect(section.characters).toEqual({ open: [], resolvedCount: 0, sharedRows: 0 })
  })
})

describe("what a file's section says about recording progress", () => {
  it("keeps a character who has recorded nothing at all, with a count of zero", () => {
    // The lesson the export preview learnt the hard way: a character with no
    // takes simply vanished from the list, and you found out by opening the zip
    // and noticing somebody missing.
    const section = buildFileSection(
      input({
        textCells: [named("s1", "MARY"), named("s2", "SIMON")],
        cueCells: [named("c1", "MARY", { startTime: 1, ...take("c1") }), named("c2", "SIMON")],
        links: buildCueLinkIndex([edge("s1", "c1"), edge("s2", "c2")]),
      }),
    )
    const simon = section.progress.characters.find((c) => c.name === "SIMON")
    expect(simon?.clipCount).toBe(0)
    expect(simon?.missingCount).toBe(1)
    expect(section.progress).toMatchObject({ recorded: 1, missing: 1, untimed: 0 })
  })

  it("does not report a character called Narrator for the lines nobody cast", () => {
    // What Sam saw on the first real report. `resolveCastVoice` falls back to
    // the project's built-in Narrator for any cell with no assignment, so every
    // unlabeled line collected under a row reading "Narrator" — in a document
    // about who says what, that is a casting decision nobody made.
    const bare = (id: string): CellData =>
      cell({ id, startTime: 1, endTime: 2, ...take(id) })
    const section = buildFileSection(
      input({ textCells: [], cueCells: [bare("c1"), bare("c2")] }),
    )
    const names = section.progress.characters.map((c) => c.name)
    expect(names).not.toContain("Narrator")
    expect(names).toContain("(no character assigned)")
    // One row for all of them, and the counts still add up.
    expect(section.progress.characters).toHaveLength(1)
    expect(section.progress.recorded).toBe(2)
  })

  it("puts the uncast lines after the cast, not among them", () => {
    const section = buildFileSection(
      input({
        textCells: [named("s1", "MARY")],
        cueCells: [
          cell({ id: "c0", startTime: 0, endTime: 1, ...take("c0") }),
          named("c1", "MARY", { startTime: 2, ...take("c1") }),
        ],
        links: buildCueLinkIndex([edge("s1", "c1")]),
      }),
    )
    expect(section.progress.characters.map((c) => c.name)).toEqual([
      "MARY",
      "(no character assigned)",
    ])
  })

  it("counts a recording with no start time as untimed, not as done", () => {
    // It exists and it cannot be placed, which is neither "recorded" nor
    // "missing" — and it is the state that silently loses audio in an export.
    const section = buildFileSection(
      input({
        textCells: [named("s1", "MARY")],
        cueCells: [named("c1", "MARY", take("c1"))],
        links: buildCueLinkIndex([edge("s1", "c1")]),
      }),
    )
    expect(section.progress).toMatchObject({ recorded: 0, missing: 0, untimed: 1 })
  })

  it("reads the takes off the subtitle rows when the file has no audio-cue sibling", () => {
    // An older project, or a dub built straight onto the subtitles. Reading
    // only the cue cells would report a fully recorded episode as empty.
    const section = buildFileSection(
      input({
        textCells: [named("s1", "MARY", { startTime: 1, ...take("s1") })],
        cueCells: [],
      }),
    )
    expect(section.progress.characters.map((c) => c.name)).toEqual(["MARY"])
    expect(section.progress.recorded).toBe(1)
  })
})

describe("what a file's section says about cue pairing", () => {
  it("reports an audio cue with no subtitle behind it, with its timecode and what is heard", () => {
    const section = buildFileSection(
      input({
        textCells: [named("s1", "MARY")],
        cueCells: [
          named("c1", "MARY", { startTime: 1, original: "Rabbi." }),
          cell({ id: "c2", startTime: 60, original: "Get the nets." }),
        ],
        links: buildCueLinkIndex([edge("s1", "c1")]),
      }),
    )
    expect(section.pairing.cues).toBe(2)
    expect(section.pairing.paired).toBe(1)
    expect(section.pairing.orphans).toEqual([
      { cueId: "c2", heard: "Get the nets.", startSec: 60 },
    ])
  })

  it("treats a cue whose list of links is empty as unpaired", () => {
    // `buildCueLinkIndex` never makes a key without an edge, but an index
    // assembled by hand can leave one behind — and an orphan counted as paired
    // is the one mistake this section must not make.
    const section = buildFileSection(
      input({
        cueCells: [cell({ id: "c1", startTime: 3, original: "Hm." })],
        links: { cuesForText: new Map(), textForCue: new Map([["c1", []]]) },
      }),
    )
    expect(section.pairing.paired).toBe(0)
    expect(section.pairing.orphans.map((o) => o.cueId)).toEqual(["c1"])
  })

  it("puts the unpaired cues in the order they are heard, with the untimed ones last", () => {
    // She works through them by scrubbing the film, so the list has to be in
    // the order the film plays. A cue with no time cannot be found that way at
    // all, so it goes at the end rather than sorting as a second zero.
    const section = buildFileSection(
      input({
        cueCells: [
          cell({ id: "late", startTime: 900, original: "It is finished." }),
          cell({ id: "untimed", original: "…" }),
          cell({ id: "early", startTime: 12, original: "Rabbi." }),
        ],
      }),
    )
    expect(section.pairing.orphans.map((o) => o.cueId)).toEqual(["early", "late", "untimed"])
  })

  it("reports an empty orphan list when every cue is paired", () => {
    const section = buildFileSection(
      input({
        textCells: [named("s1", "MARY")],
        cueCells: [named("c1", "MARY", { startTime: 1 })],
        links: buildCueLinkIndex([edge("s1", "c1")]),
      }),
    )
    expect(section.pairing).toEqual({ cues: 1, paired: 1, orphans: [] })
  })
})

describe("what a file's section says about the clock", () => {
  const timebaseOf = (timebase: ReportFileInput["timebase"]) =>
    buildFileSection(input({ timebase })).timebase

  it("names both frame rates when the import knew them", () => {
    expect(timebaseOf({ fromFps: "24", toFps: "23.976", scale: 1.001 })).toEqual({
      kind: "corrected",
      label: "24 → 23.976 fps",
    })
  })

  it("falls back to the percentage when the rates could not be named", () => {
    // 24-against-23.976 and 30-against-29.97 are the same ratio, so a
    // correction can be exact and still have no frame rate anyone can put to
    // it. The report says what was done rather than guessing at a rate.
    expect(timebaseOf({ scale: 1.001 })).toEqual({
      kind: "corrected",
      label: "0.1% correction applied",
    })
  })

  it("calls the file aligned when nothing was rescaled", () => {
    expect(timebaseOf({ scale: 1 })).toMatchObject({ kind: "aligned" })
    // Under a twentieth of a percent is less than two frames across an hour —
    // real, arithmetically, and not a correction anybody can see.
    expect(timebaseOf({ scale: 1.0001 })).toMatchObject({ kind: "aligned" })
  })

  it("says the timing was never checked rather than implying it was fine", () => {
    // Episode 306 imported wrong with no correction, no message and nothing on
    // screen to say a check had been declined. A refusal to guess is fine; an
    // invisible one is how a whole episode goes bad quietly.
    expect(timebaseOf(undefined).kind).toBe("unknown")
    expect(timebaseOf(null).kind).toBe("unknown")
    expect(timebaseOf(null).label).toMatch(/no record/i)
  })
})

describe("finding cast names spelled more than one way", () => {
  const filesWith = (...names: { file: string; cast: string[] }[]): ReportFileInput[] =>
    names.map((f, i) =>
      input({
        fileId: `f${i}`,
        fileName: f.file,
        textCells: f.cast.map((n, j) => named(`s${i}-${j}`, n)),
      }),
    )

  it("groups MARY and Mary, which are one name typed two ways", () => {
    const groups = findNameVariants(filesWith({ file: "Episode 101", cast: ["MARY", "Mary"] }))
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe("mary")
    expect(groups[0].variants.map((v) => v.name).sort()).toEqual(["MARY", "Mary"])
  })

  it("does not group MARY and MARY MAGDALENE, who are two different people", () => {
    expect(
      findNameVariants(filesWith({ file: "Episode 101", cast: ["MARY", "MARY MAGDALENE"] })),
    ).toEqual([])
  })

  it("says nothing when every name is spelled one way", () => {
    expect(
      findNameVariants(
        filesWith(
          { file: "Episode 101", cast: ["MARY", "JESUS", "JESUS"] },
          { file: "Episode 102", cast: ["JESUS"] },
        ),
      ),
    ).toEqual([])
  })

  it("ignores the non-breaking space one of the two sheets separates names with", () => {
    // Measured on episode 101: the audio sheet uses U+00A0 throughout. Treating
    // that as a different spelling would report every multi-word character in
    // the cast — forty findings, none of them visible on the page.
    expect(
      findNameVariants(
        filesWith({ file: "Episode 101", cast: ["MARY MAGDALENE", "MARY MAGDALENE"] }),
      ),
    ).toEqual([])
  })

  it("leaves ANDREW. and ANDREW alone, because the two sheets differ that way on every character", () => {
    // A deliberate limit, not an oversight. The subtitle sheet ends names with
    // a full stop and the audio sheet does not, so folding punctuation here
    // would open the section with one finding per cast member. That difference
    // is reported per line by the character comparison, where it can be seen
    // against the link it affects.
    expect(findNameVariants(filesWith({ file: "Episode 101", cast: ["ANDREW.", "ANDREW"] }))).toEqual(
      [],
    )
  })

  it("counts each spelling per file, so a finding can be traced to the episode that made it", () => {
    const groups = findNameVariants(
      filesWith(
        { file: "Episode 101", cast: ["MARY", "MARY", "MARY"] },
        { file: "Episode 102", cast: ["Mary", "MARY"] },
      ),
    )
    expect(groups).toHaveLength(1)
    // The dominant spelling leads, so the shape of the mistake is obvious
    // without the report having to claim which one is right.
    expect(groups[0].variants[0]).toEqual({
      name: "MARY",
      files: [
        { fileName: "Episode 101", count: 3 },
        { fileName: "Episode 102", count: 1 },
      ],
    })
    expect(groups[0].variants[1]).toEqual({
      name: "Mary",
      files: [{ fileName: "Episode 102", count: 1 }],
    })
  })

  it("reads the audio sheet as well as the subtitle sheet", () => {
    // The disagreement that survives every per-file check is one sheet in one
    // episode against the other sheet in another.
    const groups = findNameVariants([
      input({ fileName: "Episode 101", textCells: [named("s1", "SIMON")] }),
      input({ fileId: "f2", fileName: "Episode 102", cueCells: [named("c1", "Simon")] }),
    ])
    expect(groups.map((g) => g.key)).toEqual(["simon"])
  })

  it("never proposes which spelling is the right one", () => {
    // Detection only. The app cannot know whether the cast list says MARY or
    // Mary, and a confident wrong answer is worse than no answer — merging cast
    // names is a change to the client's own files that only they can make.
    const [group] = findNameVariants(filesWith({ file: "Episode 101", cast: ["MARY", "Mary"] }))
    expect(Object.keys(group).sort()).toEqual(["key", "variants"])
    expect(Object.keys(group.variants[0]).sort()).toEqual(["files", "name"])
  })
})

describe("the document itself", () => {
  const cleanSection = (over: Partial<ReportFileSection> = {}): ReportFileSection => ({
    fileId: "f1",
    fileName: "Episode 101",
    characters: { open: [], resolvedCount: 0, sharedRows: 0 },
    progress: {
      characters: [
        { key: "MARY", name: "MARY", clipCount: 12, missingCount: 0, untimedCount: 0, totalDurationMs: 1000 },
      ],
      recorded: 12,
      missing: 0,
      untimed: 0,
    },
    pairing: { cues: 12, paired: 12, orphans: [] },
    timebase: { kind: "aligned", label: "Already on the subtitles' clock — no correction was needed" },
    ...over,
  })

  it("is one page with nothing to fetch", () => {
    // It gets emailed, saved to a desktop and opened on a machine that has
    // never heard of aquilla and may have no internet. Anything fetched is
    // something that will one day fail to arrive.
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
    })
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain("<style>")
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/\bsrc=/i)
    expect(html).not.toMatch(/https?:\/\//)
  })

  it("still prints every section, and says in words that it is clean, when nothing is wrong", () => {
    // THE ASSERTION THIS WHOLE MODULE EXISTS FOR. A section that disappears
    // when it has nothing to report cannot be told apart from a check that
    // never ran, and the document is the certificate that the checks ran.
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
    })
    expect(html).toContain("Character sheets")
    expect(html).toContain("Recording progress")
    expect(html).toContain("Cue pairing")
    expect(html).toContain("Timing")
    expect(html).toContain("No open disagreements")
    expect(html).toContain("Every line in this file has a recording")
    expect(html).toContain("All 12 audio cues are paired with a subtitle line")
    expect(html).toContain("Every cast name is spelled the same way")
    expect(html).toContain("Nothing in this project needs a decision")
  })

  it("counts the things that need a decision, and does not count unrecorded lines among them", () => {
    // A fresh episode has hundreds of lines nobody has recorded yet. That is
    // work outstanding, not a mistake, and opening the report with "412 things
    // need a decision" would bury the ones that are actually wrong.
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [
        cleanSection({
          progress: { characters: [], recorded: 0, missing: 412, untimed: 0 },
        }),
      ],
      nameVariants: [],
    })
    expect(html).toContain("Nothing in this project needs a decision")
    expect(html).toContain("412")
  })

  it("escapes a character name someone typed with angle brackets in it", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [
        cleanSection({
          progress: {
            characters: [
              {
                key: "x",
                name: "<MARY>",
                clipCount: 1,
                missingCount: 0,
                untimedCount: 0,
                totalDurationMs: null,
              },
            ],
            recorded: 1,
            missing: 0,
            untimed: 0,
          },
        }),
      ],
      nameVariants: [],
    })
    expect(html).toContain("&lt;MARY&gt;")
    expect(html).not.toContain("<MARY>")
  })

  it("escapes the project name, the file names and the dialogue", () => {
    const html = renderProjectReport({
      projectName: 'Ben & "The Chosen"',
      files: [
        cleanSection({
          fileName: "<Episode 101>",
          pairing: {
            cues: 1,
            paired: 0,
            orphans: [{ cueId: "c1", heard: "5 > 3 & rising", startSec: 60 }],
          },
        }),
      ],
      nameVariants: [],
    })
    expect(html).toContain("Ben &amp; &quot;The Chosen&quot;")
    expect(html).toContain("&lt;Episode 101&gt;")
    expect(html).toContain("5 &gt; 3 &amp; rising")
    expect(html).not.toContain("<Episode 101>")
  })

  it("prints an unpaired cue's timecode the way the subtitle files print it", () => {
    // So a number read off the page can be typed straight into whatever she is
    // scrubbing, without being converted first.
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [
        cleanSection({
          pairing: {
            cues: 2,
            paired: 1,
            orphans: [{ cueId: "c1", heard: "Get the nets.", startSec: 60 }],
          },
        }),
      ],
      nameVariants: [],
    })
    expect(html).toContain("00:01:00.000")
  })

  it("says what was done to the clock, and puts a mark against a file where nothing was checked", () => {
    // A correction is information; an alignment is an all-clear; no record at
    // all is the one worth her eye, because that is how episode 306 imported
    // against the wrong clock without anybody seeing it happen.
    const timing = (timebase: ReportFileSection["timebase"]) =>
      renderProjectReport({
        projectName: "The Chosen",
        files: [cleanSection({ timebase })],
        nameVariants: [],
      })
    expect(timing({ kind: "corrected", label: "24 → 23.976 fps" })).toContain(
      "rescaled on import (24 → 23.976 fps)",
    )
    expect(timing({ kind: "aligned", label: "Already on the subtitles' clock" })).toContain(
      `<p class="clear">Already on the subtitles&#39; clock.</p>`,
    )
    expect(timing({ kind: "unknown", label: "No record of a timing check" })).toContain(
      `<p class="flag">No record of a timing check.</p>`,
    )
  })

  it("keeps the files in the order they were given", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection({ fileName: "Episode 101" }), cleanSection({ fileId: "f2", fileName: "Episode 102" })],
      nameVariants: [],
    })
    expect(html.indexOf("Episode 101")).toBeLessThan(html.indexOf("Episode 102"))
  })

  it("names both spellings of a name written two ways, and where each one appears", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [
        {
          key: "mary",
          variants: [
            { name: "MARY", files: [{ fileName: "Episode 101", count: 37 }] },
            { name: "Mary", files: [{ fileName: "Episode 102", count: 1 }] },
          ],
        },
      ],
    })
    expect(html).toContain("2 spellings of")
    expect(html).toContain("MARY")
    expect(html).toContain("Mary")
    expect(html).toContain("Episode 101 (37)")
    expect(html).toContain("Episode 102 (1)")
    expect(html).toContain("1 name is written more than one way")
  })

  it("shows what the two sheets each said about a line that needs a decision", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [
        cleanSection({
          characters: {
            open: [
              {
                cueCellId: "c1",
                textCellId: "s1",
                heard: "Good.",
                name: { kind: "character", subtitle: "ANDREW", audio: "SIMON" },
                context: { camera: "on" },
              },
            ],
            resolvedCount: 0,
            sharedRows: 0,
          },
        }),
      ],
      nameVariants: [],
    })
    expect(html).toContain("ANDREW")
    expect(html).toContain("SIMON")
    expect(html).toContain("Good.")
    // The agreed camera angle rides along: click the film, see who it is on.
    expect(html).toContain("on camera")
    expect(html).not.toContain("No open disagreements")
  })
})

// ── The episodes the report could not open (Sam, 2026-08-20) ────────────────
//
// The orchestrator has always collected these, and until now the document
// never mentioned them — the only trace was a status line in the export
// dialog, gone the moment it closed. A project where two episodes failed to
// load produced a clean-looking certificate covering the other three, with
// nothing on the page to say so. A file missing from a health report reads as
// a file with nothing wrong.

describe("files the report could not read", () => {
  const cleanSection = (): ReportFileSection => ({
    fileId: "f1",
    fileName: "Episode 101",
    characters: { open: [], resolvedCount: 0, sharedRows: 0 },
    progress: { characters: [], recorded: 0, missing: 0, untimed: 0 },
    pairing: { cues: 0, paired: 0, orphans: [] },
    timebase: { kind: "unknown", label: "No record of a timing check" },
  })

  it("names them, and says the rest of the document does not cover them", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
      unreadable: [
        { fileName: "episode-207.vtt", reason: "no access to this file" },
        { fileName: "episode-306.vtt", reason: "network error" },
      ],
    })
    expect(html).toContain("Not checked")
    expect(html).toContain("episode-207.vtt")
    expect(html).toContain("no access to this file")
    expect(html).toContain("episode-306.vtt")
    expect(html).toMatch(/2 files could not be read/)
  })

  it("reads as one file in the singular", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
      unreadable: [{ fileName: "episode-207.vtt", reason: "no access to this file" }],
    })
    expect(html).toMatch(/1 file could not be read/)
    expect(html).toContain("nothing below covers it")
  })

  it("says nothing at all when every file was read", () => {
    // The one section that is NOT an always-print one: a permanent
    // "0 unreadable" line is noise, and this is a finding rather than a
    // statistic. Everything else in the report states its own all-clear.
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
      unreadable: [],
    })
    expect(html).not.toContain("Not checked")
  })

  it("is absent, not broken, on a report built before the field existed", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
    })
    expect(html).not.toContain("Not checked")
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
  })

  it("escapes a filename rather than letting it reach the page as markup", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
      unreadable: [{ fileName: "<script>bad</script>.vtt", reason: "gone" }],
    })
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain("&lt;script&gt;")
  })

  it("sits above the per-file sections, since it qualifies all of them", () => {
    const html = renderProjectReport({
      projectName: "The Chosen",
      files: [cleanSection()],
      nameVariants: [],
      unreadable: [{ fileName: "episode-207.vtt", reason: "gone" }],
    })
    expect(html.indexOf("Not checked")).toBeLessThan(html.indexOf("Episode 101"))
  })
})
