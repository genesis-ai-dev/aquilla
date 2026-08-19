// Everything the app knows about an episode's health, as one document she can
// keep. (AQU-646, 2026-08-19)
//
// The client contact does not translate and does not dub. Her job is
// CONSISTENCY: read the files, find the errors, get the discrepancies resolved
// with whoever made them. Every number she needs already exists somewhere in
// the app — the character drawer knows which lines the two sheets disagree
// about, the export dialog knows who has nothing recorded, the import knows it
// rescaled the clock on the way in — and every one of them lives inside a panel
// that closes. Close it and the knowledge is gone: nothing to take to Monday's
// meeting, nothing to email to the team that made the errors, nothing to file
// against the episode.
//
// Sam's framing was "a report export that reports progress basically". This is
// that — the same numbers, in one document, that survives being closed.
//
// AN ALL-CLEAR IS CONTENT, NOT ABSENCE. This is the design point everything
// else here bends around. The obvious build renders a section per problem and
// nothing when there are none, which produces a beautiful empty page and tells
// the reader precisely nothing: she cannot distinguish "the pairing was checked
// and every cue has a subtitle" from "the pairing was never checked" from "the
// report is broken". The document is the CERTIFICATE that the episode was
// looked at, so a clean section stays and says it is clean, in words. Sections
// never vanish. See `renderProjectReport`, where the positive sentences live.
//
// PURE. No fetching, no React, no dates — builders and a renderer. The
// orchestrator does the reading and calls these. That is also what makes the
// whole thing testable, which matters more here than usual: this document is
// the one artefact that leaves the building.
//
// NOTHING HERE COMPUTES ANYTHING NEW. Every finding comes from the module that
// already owns that question — `character-agreement.ts` for the two sheets,
// `audio-by-character.ts` for who is recorded, `cue-character.ts` for who
// speaks a cue. A second implementation of any of them would drift from what is
// on screen, and a report that disagrees with the app is worse than no report.

import type { CellData } from "@/hooks/useCells"
import type { CharacterResolution, ProjectTtsSettings } from "@/lib/parsers/types"
import type { CueLinkIndex } from "@/lib/sync/cell-links-read"
import {
  compareCharacterSources,
  type CharacterDisagreement,
} from "@/lib/timeline/character-agreement"
import {
  cameraLabel,
  formatCueCharacter,
  resolveCueCharacter,
} from "@/lib/timeline/cue-character"
import { formatVttTime } from "@/lib/video/vtt-generator"
import { previewAudioByCharacter, type CharacterPreview } from "./audio-by-character"

// ─── What the orchestrator hands us ──────────────────────────────────────────

export interface ReportFileInput {
  fileId: string
  fileName: string
  /** The subtitle file's cells (attachment-merged not required). */
  textCells: CellData[]
  /** The audio-cue sibling's cells, ATTACHMENT-MERGED (so takes are visible).
   *  Empty when the file has no sibling. */
  cueCells: CellData[]
  links: CueLinkIndex
  settings: ProjectTtsSettings | undefined
  resolutions?: Record<string, CharacterResolution>
  /**
   * What the import recorded, when it recorded anything.
   *
   * Structurally `AudioVttTimebaseRecord` from `lib/import/audio-vtt.ts`, spelt
   * out rather than imported: an export module that depends on the import path
   * for a three-field shape buys nothing, and the manifest is provenance —
   * whatever else it grows, this is the part a report is entitled to read.
   */
  timebase?: { fromFps?: string; toFps?: string; scale: number } | null
}

// ─── What the renderer is handed ─────────────────────────────────────────────

export interface ReportFileSection {
  fileId: string
  fileName: string
  characters: { open: CharacterDisagreement[]; resolvedCount: number; sharedRows: number }
  progress: { characters: CharacterPreview[]; recorded: number; missing: number; untimed: number }
  pairing: { cues: number; paired: number; orphans: { cueId: string; heard: string; startSec: number | null }[] }
  timebase: { kind: "corrected" | "aligned" | "unknown"; label: string }
}

export interface NameVariantGroup {
  /** The normalised key these spellings collapse to. */
  key: string
  variants: { name: string; files: { fileName: string; count: number }[] }[]
}

export interface ProjectReportData {
  projectName: string
  files: ReportFileSection[]
  nameVariants: NameVariantGroup[]
}

// ─── One file ────────────────────────────────────────────────────────────────

/**
 * A scale this close to 1 is not a correction anybody can see — 0.05% is under
 * two frames across a whole hour. Mirrors `MIN_SCALE_DELTA` in
 * `lib/import/timebase.ts`, which is where the number was chosen and argued;
 * it is not exported, and importing the import path for one float would be the
 * wrong dependency to buy. If that threshold ever moves, this one follows it.
 */
const NEGLIGIBLE_SCALE_DELTA = 0.0005

/** "0.1", "4.2", "12" — a percentage a person reads, not a float. */
function formatPercent(value: number): string {
  return value >= 1
    ? value.toFixed(1).replace(/\.0$/, "")
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

/**
 * What was done to this file's clock, in a sentence.
 *
 * Three outcomes and all three are worth printing. "Corrected" is the one that
 * explains a timeline someone thinks looks half a second off; "aligned" is the
 * evidence the check ran and found nothing; "unknown" is neither, and saying so
 * is the whole lesson of episode 306 — a declined check that left no trace let
 * a whole episode import wrong in silence.
 */
function describeTimebase(
  record: ReportFileInput["timebase"],
): ReportFileSection["timebase"] {
  if (!record || !Number.isFinite(record.scale)) {
    return {
      kind: "unknown",
      label: "No record of a timing check — these cues were imported before the check existed, or without one",
    }
  }
  if (Math.abs(record.scale - 1) < NEGLIGIBLE_SCALE_DELTA) {
    return { kind: "aligned", label: "Already on the subtitles' clock — no correction was needed" }
  }
  // The frame rates when the import could name them. It often cannot: 24
  // against 23.976 and 30 against 29.97 are the same ratio, so an exact
  // correction can be one nobody can put a frame rate to, and the percentage
  // is then the honest way to say what happened.
  if (record.fromFps && record.toFps) {
    return { kind: "corrected", label: `${record.fromFps} → ${record.toFps} fps` }
  }
  return {
    kind: "corrected",
    label: `${formatPercent(Math.abs(record.scale - 1) * 100)}% correction applied`,
  }
}

export function buildFileSection(input: ReportFileInput): ReportFileSection {
  const { fileId, fileName, textCells, cueCells, links, settings, resolutions } = input

  const agreement = compareCharacterSources({
    cues: cueCells,
    textCells,
    links,
    ...(resolutions ? { resolutions } : {}),
  })

  // WHERE THE TAKES LIVE depends on whether this file ever had an audio VTT.
  // With a cue sibling every recording hangs off a cue; without one — an older
  // project, or a dub built straight onto the subtitles — they hang off the
  // subtitle rows themselves, and reading only `cueCells` would report a fully
  // recorded episode as having nothing at all. The resolver copes with both
  // because a cell carrying its own cast name answers for itself.
  const spokenCells = cueCells.length > 0 ? cueCells : textCells
  const characters = previewAudioByCharacter(spokenCells, settings, (cell) =>
    formatCueCharacter(resolveCueCharacter({ cell, links, textCells }).names),
  )

  let recorded = 0
  let missing = 0
  let untimed = 0
  for (const character of characters) {
    recorded += character.clipCount
    missing += character.missingCount
    untimed += character.untimedCount
  }

  // An orphan is a heard line the film has and the script does not — either the
  // pairing missed it or nobody wrote it down, and both are hers to chase. The
  // empty array counts: `buildCueLinkIndex` only ever creates a key alongside
  // an edge, but a caller assembling an index by hand can leave one behind, and
  // an orphan reported as paired is the one mistake this section must not make.
  const orphans: ReportFileSection["pairing"]["orphans"] = []
  let paired = 0
  for (const cue of cueCells) {
    const linked = links.textForCue.get(cue.id)
    if (linked && linked.length > 0) {
      paired += 1
      continue
    }
    orphans.push({ cueId: cue.id, heard: cue.original ?? "", startSec: cue.startTime ?? null })
  }
  // In the order she will hear them, which is the order she can find them in.
  // A cue with no time of its own cannot be found by scrubbing at all, so it
  // goes last rather than sorting as second zero.
  orphans.sort((a, b) => (a.startSec ?? Number.POSITIVE_INFINITY) - (b.startSec ?? Number.POSITIVE_INFINITY))

  return {
    fileId,
    fileName,
    characters: {
      open: agreement.open,
      resolvedCount: agreement.resolved.length,
      sharedRows: agreement.sharedRows,
    },
    progress: { characters, recorded, missing, untimed },
    pairing: { cues: cueCells.length, paired, orphans },
    timebase: describeTimebase(input.timebase),
  }
}

// ─── One name, spelled several ways ──────────────────────────────────────────

/**
 * The spelling as it will be PRINTED — the name with its whitespace tidied and
 * nothing else touched.
 *
 * Collapsing whitespace before comparing is not cosmetic. The audio character
 * sheet separates words with a non-breaking space as a matter of course
 * (measured on episode 101, see `character-agreement.ts`), so without this
 * every multi-word character in the cast would be reported as two spellings —
 * forty findings, all of them invisible on the page, all of them wrong. The
 * report would be useless on its first run.
 */
const tidySpelling = (raw: string): string => raw.replace(/\s+/g, " ").trim()

/**
 * What two spellings must share to be the same name.
 *
 * DELIBERATELY ONLY CASE AND SPACING. Folding punctuation too would collapse
 * "ANDREW." into "ANDREW" — and the two client sheets differ exactly that way
 * on every single character, so the section would open with forty findings that
 * are nothing but the two sheets' house styles. `character-agreement.ts`
 * already reports that difference per line, where it can be seen against the
 * link it affects. Here it would be noise, and noise is how a report stops
 * being read.
 */
const variantKey = (raw: string): string => tidySpelling(raw).toLowerCase()

const castNameOf = (cell: CellData): string =>
  cell.metadata && typeof cell.metadata.cast_name === "string" ? cell.metadata.cast_name : ""

/**
 * Cast names written more than one way across the project. Pure; no I/O.
 *
 * Both sheets of every file are read, because that is where the answer is: one
 * spelling in the subtitle sheet of 101 and another in the audio sheet of 104
 * is exactly the kind of thing that survives every per-file check and shows up
 * in a deliverable. Per-file counts ride along so a finding can be traced to
 * the episode — and the team — that produced it.
 *
 * DETECTION ONLY. There is no "correct" spelling here and no suggestion of one,
 * and that is a decision, not an omission: the app cannot know whether the cast
 * list says MARY or Mary, a wrong guess presented confidently is worse than no
 * guess, and merging cast names is a change to the client's own source files
 * that only they can authorise. The report says "these two disagree" and stops.
 */
export function findNameVariants(files: readonly ReportFileInput[]): NameVariantGroup[] {
  // key → spelling → fileName → count. Insertion order carries the file order
  // the caller gave us, which is episode order, which is how she reads.
  const byKey = new Map<string, Map<string, Map<string, number>>>()

  for (const file of files) {
    for (const cell of [...file.textCells, ...file.cueCells]) {
      const raw = castNameOf(cell)
      if (raw === "") continue
      const spelling = tidySpelling(raw)
      if (spelling === "") continue
      const key = variantKey(spelling)
      let spellings = byKey.get(key)
      if (!spellings) {
        spellings = new Map()
        byKey.set(key, spellings)
      }
      let counts = spellings.get(spelling)
      if (!counts) {
        counts = new Map()
        spellings.set(spelling, counts)
      }
      counts.set(file.fileName, (counts.get(file.fileName) ?? 0) + 1)
    }
  }

  const groups: NameVariantGroup[] = []
  for (const [key, spellings] of byKey) {
    // One spelling is not a disagreement. This is the line that keeps the
    // section down to the handful of real findings — every character in the
    // project passes through here and almost all of them leave by this exit.
    if (spellings.size < 2) continue
    const variants = [...spellings].map(([name, counts]) => ({
      name,
      files: [...counts].map(([fileName, count]) => ({ fileName, count })),
    }))
    // The dominant spelling leads: it is almost always the intended one, and
    // seeing "MARY (37) / Mary (1)" makes the shape of the error obvious
    // without the report having to claim which is right.
    variants.sort((a, b) => {
      const total = (v: typeof a) => v.files.reduce((n, f) => n + f.count, 0)
      return total(b) - total(a) || a.name.localeCompare(b.name)
    })
    groups.push({ key, variants })
  }
  // Alphabetical, so a name can be looked up rather than hunted for.
  return groups.sort((a, b) => a.key.localeCompare(b.key))
}

// ─── The document ────────────────────────────────────────────────────────────

/**
 * Every interpolation goes through here, without exception.
 *
 * The strings in this document are the client's own: character names, heard
 * dialogue, file names, all of it typed by people into spreadsheets. A cast
 * name containing "<" — or a line of dialogue quoting one — must show up on the
 * page as those characters and not as the start of a tag that eats the rest of
 * the report. Quotes are escaped too, though nothing here is currently written
 * into an attribute, because the day someone adds a `title=` is not the day to
 * remember this.
 */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A timecode in the same form as the subtitle files themselves, so a number
 *  read here can be typed straight into whatever she is scrubbing. */
const timecode = (startSec: number | null): string =>
  startSec == null ? "—" : formatVttTime(startSec)

/** What the sheets disagree ABOUT, in her words rather than the type's. */
function axesOf(d: CharacterDisagreement): string {
  const axes: string[] = []
  if (d.name) axes.push(d.name.kind === "character" ? "Speaker" : "Spelling")
  if (d.camera) axes.push("Camera")
  return axes.join(" and ")
}

/** One side's answer, both axes on one line: "JESUS · on camera". */
function sideOf(
  d: CharacterDisagreement,
  side: "subtitle" | "audio",
): string {
  const parts: string[] = []
  if (d.name) parts.push(d.name[side])
  if (d.camera) {
    const label = cameraLabel(d.camera[side])
    if (label) parts.push(label)
  }
  return parts.join(" · ")
}

function disagreementsHtml(characters: ReportFileSection["characters"]): string {
  const notes: string[] = []
  if (characters.resolvedCount > 0) {
    notes.push(`${plural(characters.resolvedCount, "line has", "lines have")} already been settled.`)
  }
  if (characters.sharedRows > 0) {
    notes.push(
      `${plural(characters.sharedRows, "subtitle row serves", "subtitle rows serve")} several heard lines, ` +
        "so one name cannot be right about all of them — counted here, not offered as work.",
    )
  }
  const note = notes.length > 0 ? `<p class="note">${esc(notes.join(" "))}</p>` : ""

  if (characters.open.length === 0) {
    // The all-clear. Said in full, because "the two sheets were compared and
    // they agree" is a result somebody worked for and is entitled to see.
    return (
      `<p class="clear">No open disagreements — the two character sheets agree about every line they both name.</p>` +
      note
    )
  }

  const rows = characters.open
    .map((d) => {
      const context = d.context
        ? [d.context.name, d.context.camera ? cameraLabel(d.context.camera) : null]
            .filter((x): x is string => Boolean(x))
            .join(" · ")
        : ""
      const settled = d.settled ? ` <span class="tag">part settled</span>` : ""
      return (
        "<tr>" +
        `<td>${esc(axesOf(d))}${settled}</td>` +
        `<td>${esc(d.heard)}${context ? `<span class="ctx">Both agree: ${esc(context)}</span>` : ""}</td>` +
        `<td>${esc(sideOf(d, "subtitle"))}</td>` +
        `<td>${esc(sideOf(d, "audio"))}</td>` +
        "</tr>"
      )
    })
    .join("")

  return (
    `<p>${plural(characters.open.length, "line needs", "lines need")} a decision.</p>` +
    "<table><thead><tr>" +
    "<th>What differs</th><th>Heard line</th><th>Subtitle sheet says</th><th>Audio sheet says</th>" +
    "</tr></thead><tbody>" +
    rows +
    "</tbody></table>" +
    note
  )
}

function progressHtml(progress: ReportFileSection["progress"]): string {
  if (progress.characters.length === 0) {
    return `<p class="clear">This file has no lines to record yet.</p>`
  }
  const rows = progress.characters
    .map(
      (c) =>
        "<tr>" +
        `<td>${esc(c.name)}</td>` +
        `<td class="num">${c.clipCount}</td>` +
        `<td class="num${c.missingCount > 0 ? " bad" : ""}">${c.missingCount}</td>` +
        `<td class="num${c.untimedCount > 0 ? " bad" : ""}">${c.untimedCount}</td>` +
        "</tr>",
    )
    .join("")
  // Everything-recorded is stated rather than left to be inferred from a column
  // of zeroes, for the same reason the other sections say it.
  const outstanding: string[] = []
  if (progress.missing > 0) {
    outstanding.push(`${plural(progress.missing, "line has", "lines have")} nothing recorded yet`)
  }
  if (progress.untimed > 0) {
    outstanding.push(
      `${plural(progress.untimed, "recording has", "recordings have")} no start time, so they cannot be placed`,
    )
  }
  const verdict =
    outstanding.length === 0
      ? `<p class="clear">Every line in this file has a recording, and every recording has a place on the timeline.</p>`
      : `<p>${outstanding.join(", and ")}.</p>`
  return (
    verdict +
    "<table><thead><tr>" +
    "<th>Character</th><th>Recorded</th><th>Nothing recorded</th><th>Untimed</th>" +
    "</tr></thead><tbody>" +
    rows +
    "</tbody><tfoot><tr>" +
    `<td>All characters</td><td class="num">${progress.recorded}</td>` +
    `<td class="num">${progress.missing}</td><td class="num">${progress.untimed}</td>` +
    "</tr></tfoot></table>"
  )
}

function pairingHtml(pairing: ReportFileSection["pairing"]): string {
  if (pairing.cues === 0) {
    return `<p class="clear">No audio cues have been imported for this file, so there is nothing to pair.</p>`
  }
  if (pairing.orphans.length === 0) {
    return pairing.cues === 1
      ? `<p class="clear">The one audio cue in this file is paired with a subtitle line.</p>`
      : `<p class="clear">All ${pairing.cues} audio cues are paired with a subtitle line.</p>`
  }
  // NO CAP, deliberately. Two hundred orphans make a long document and a long
  // document is the correct output for two hundred orphans — she has to find
  // each one, and "and 187 more" would hand her a list she cannot work from.
  const rows = pairing.orphans
    .map(
      (o) =>
        `<tr><td class="tc">${esc(timecode(o.startSec))}</td><td>${esc(o.heard)}</td></tr>`,
    )
    .join("")
  return (
    `<p>${pairing.paired} of ${pairing.cues} audio cues are paired with a subtitle line. ` +
    `${plural(pairing.orphans.length, "cue is", "cues are")} heard in the film with nothing in the script:</p>` +
    "<table><thead><tr><th>At</th><th>What is heard</th></tr></thead><tbody>" +
    rows +
    "</tbody></table>"
  )
}

/**
 * The clock, as a sentence rather than a label.
 *
 * The builder's label is the bare fact ("24 → 23.976 fps") because that is what
 * anything else reading the section wants; a document wants a sentence saying
 * what was DONE. And the three outcomes are weighted differently on the page:
 * a correction is information, an alignment is an all-clear, and no record at
 * all is the one worth her eye — episode 306 imported against the wrong clock
 * precisely because a declined check left nothing behind to notice.
 */
function timingHtml(timebase: ReportFileSection["timebase"]): string {
  if (timebase.kind === "corrected") {
    return `<p>The audio cue times were rescaled on import (${esc(timebase.label)}).</p>`
  }
  return `<p class="${timebase.kind === "aligned" ? "clear" : "flag"}">${esc(timebase.label)}.</p>`
}

function fileSectionHtml(section: ReportFileSection): string {
  return (
    `<section class="file"><h2>${esc(section.fileName)}</h2>` +
    `<h3>Character sheets</h3>${disagreementsHtml(section.characters)}` +
    `<h3>Recording progress</h3>${progressHtml(section.progress)}` +
    `<h3>Cue pairing</h3>${pairingHtml(section.pairing)}` +
    `<h3>Timing</h3>${timingHtml(section.timebase)}` +
    "</section>"
  )
}

function nameVariantsHtml(groups: readonly NameVariantGroup[]): string {
  if (groups.length === 0) {
    return (
      `<section class="variants"><h2>Cast names across the project</h2>` +
      `<p class="clear">Every cast name is spelled the same way everywhere it appears.</p></section>`
    )
  }
  const tables = groups
    .map((group) => {
      const rows = group.variants
        .map((v) => {
          const where = v.files
            .map((f) => `${f.fileName} (${f.count})`)
            .join(", ")
          return `<tr><td>${esc(v.name)}</td><td>${esc(where)}</td></tr>`
        })
        .join("")
      return (
        `<div class="variant-group"><h3>${plural(group.variants.length, "spelling", "spellings")} of ` +
        `“${esc(group.key)}”</h3>` +
        "<table><thead><tr><th>As written</th><th>Where</th></tr></thead><tbody>" +
        rows +
        "</tbody></table></div>"
      )
    })
    .join("")
  return (
    `<section class="variants"><h2>Cast names across the project</h2>` +
    `<p>${plural(groups.length, "name is", "names are")} written more than one way. ` +
    "Which spelling is right is not something this report can know — these are for someone to decide.</p>" +
    tables +
    "</section>"
  )
}

function summaryHtml(data: ProjectReportData): string {
  let open = 0
  let orphans = 0
  let recorded = 0
  let missing = 0
  let untimed = 0
  for (const file of data.files) {
    open += file.characters.open.length
    orphans += file.pairing.orphans.length
    recorded += file.progress.recorded
    missing += file.progress.missing
    untimed += file.progress.untimed
  }
  // WHAT COUNTS AS A FINDING, and what does not. A line nobody has recorded yet
  // is work outstanding, not a mistake — counting it here would open a fresh
  // episode's report with "412 things need attention", which is a sentence
  // nobody reads twice and which buries the six that are actually wrong.
  // Progress is reported, loudly, on its own line just below.
  const findings = open + orphans + data.nameVariants.length
  const verdict =
    findings === 0
      ? `<p class="verdict clear">Nothing in this project needs a decision. Every check below ran and came back clean.</p>`
      : `<p class="verdict">${plural(findings, "thing needs", "things need")} a decision.</p>`

  const counts = [
    { label: "Files checked", value: String(data.files.length) },
    { label: "Character disagreements", value: String(open) },
    { label: "Unpaired audio cues", value: String(orphans) },
    { label: "Names spelled two ways", value: String(data.nameVariants.length) },
    { label: "Lines recorded", value: String(recorded) },
    { label: "Lines still to record", value: String(missing + untimed) },
  ]
    .map((c) => `<div><dt>${esc(c.label)}</dt><dd>${esc(c.value)}</dd></div>`)
    .join("")

  return `<section class="summary">${verdict}<dl>${counts}</dl></section>`
}

/**
 * The whole report, as one self-contained HTML document.
 *
 * SELF-CONTAINED IS THE REQUIREMENT, not a nicety. This file gets saved to a
 * desktop, emailed as an attachment, opened on a machine that has never heard
 * of aquilla and possibly has no internet. One inline stylesheet, no scripts,
 * no fonts, no images, no links out — anything fetched is something that will
 * one day fail to arrive and take the layout with it.
 *
 * AND IT HAS TO PRINT. Sam's use for it is a meeting; a meeting means paper.
 * Hence the print rules at the bottom of the stylesheet: sections do not split
 * across a page break where that can be avoided, table headers repeat on every
 * page of a long orphan list, and the colours are chosen to survive a
 * black-and-white printer — the "needs attention" cells are marked with weight
 * as well as colour, because a red number and a black one are the same number
 * in greyscale.
 */
export function renderProjectReport(data: ProjectReportData): string {
  const title = `${data.projectName} — consistency report`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<style>
  :root { --ink: #16181d; --muted: #5b6472; --rule: #d6dae1; --bad: #a11c2f; --good: #14603a; --tint: #f4f6f9; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2.5rem 1.5rem 4rem; background: #fff; color: var(--ink);
         font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .lede { margin: 0 0 2rem; color: var(--muted); }
  h2 { font-size: 1.2rem; margin: 2.5rem 0 .75rem; padding-bottom: .35rem; border-bottom: 2px solid var(--ink); }
  h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted);
       margin: 1.5rem 0 .4rem; }
  p { margin: .4rem 0 .8rem; }
  .verdict { font-size: 1.05rem; font-weight: 600; margin: 0 0 1rem; }
  .clear { color: var(--good); }
  .note { color: var(--muted); font-size: .9rem; }
  .flag { color: var(--bad); font-weight: 600; }
  .summary { background: var(--tint); border: 1px solid var(--rule); border-radius: 6px; padding: 1.1rem 1.25rem; }
  .summary dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem 1.25rem; margin: 0; }
  .summary dt { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .summary dd { margin: .1rem 0 0; font-size: 1.4rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin: .5rem 0 1rem; font-size: .92rem; }
  th, td { text-align: left; vertical-align: top; padding: .4rem .6rem; border-bottom: 1px solid var(--rule); }
  thead th { border-bottom: 1.5px solid var(--ink); font-size: .75rem; text-transform: uppercase;
             letter-spacing: .06em; color: var(--muted); }
  tfoot td { border-top: 1.5px solid var(--ink); border-bottom: none; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; width: 7rem; }
  td.bad { color: var(--bad); font-weight: 700; }
  td.tc { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); width: 8rem; }
  .ctx { display: block; font-size: .8rem; color: var(--muted); margin-top: .15rem; }
  .tag { display: inline-block; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em;
         border: 1px solid var(--rule); border-radius: 3px; padding: 0 .3rem; color: var(--muted); }
  .variant-group { margin-top: 1.25rem; }
  @media print {
    body { padding: 0; font-size: 11pt; }
    section, .variant-group, table { break-inside: avoid; page-break-inside: avoid; }
    h2 { break-after: avoid; page-break-after: avoid; }
    thead { display: table-header-group; }
    .summary { background: none; }
  }
</style>
</head>
<body>
<main>
<h1>${esc(data.projectName)}</h1>
<p class="lede">Consistency report</p>
${summaryHtml(data)}
${data.files.map(fileSectionHtml).join("\n")}
${nameVariantsHtml(data.nameVariants)}
</main>
</body>
</html>
`
}
