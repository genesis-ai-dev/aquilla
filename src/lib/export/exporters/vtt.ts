// WEBVTT exporter. Produces a subtitle file from timed cells; cells explicitly
// assigned to a Cast member get a `<v Name>` voice tag (default-only/unassigned
// cells stay plain — matching codex-editor's "no tag unless labeled").
// Cells without startTime/endTime are skipped.
//
// AQU-646: cues come out in TIME order, and a line someone added into a silence
// keeps its cue even with nothing written in it yet. See the notes on the sort
// and the blank-payload carve-out below.
//
// Two options ported from codex-editor (2026-08-18), which offers each as its
// own export format: cue splitting, and dropping the voice tags. Both default
// off, so the file this produces untouched is byte-identical to before.
//
// A third option (2026-08-19) is ours rather than a port: `includeSource` puts
// the source line above the target line inside every cue. Nobody would ever
// burn that in — it is a REVIEW artifact, played against the picture so someone
// can check the translation line by line against what was actually said, which
// is the one job a target-only VTT cannot do. It defaults off with the others.

import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { isUserAddedLine } from "@/lib/timeline/user-lines"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { escapeVoiceName } from "@/lib/export/vtt-voice"
import { formatVttTime, stripHtml } from "@/lib/video/vtt-generator"
import { sortedByTime } from "./subtitle-order"

export interface VttExportOptions {
  /**
   * Slice overlapping cues at every timestamp boundary, so no two cues ever
   * overlap and simultaneous speakers appear stacked in one cue.
   *
   * The material genuinely contains overlapping speech — two characters
   * talking over each other is a scene, not a mistake — and a genuinely
   * overlapping VTT is legal. But plenty of downstream tools read cues sequentially and
   * either drop the second or render them on top of one another, so this is
   * the shape to hand those. Ported from codex-editor's `buildSplitCues`.
   */
  cueSplitting?: boolean
  /** Leave the `<v Character>` tags off, for a tool that would render them as
   *  literal text rather than as speaker annotations. */
  excludeLabels?: boolean
  /**
   * Carry the source line into every cue, above the target line, separated by
   * a single newline — a bilingual file for review rather than for delivery.
   *
   * A single newline, never a blank one: a blank line ends the cue per the
   * WebVTT spec, so `"\n\n"` between the two languages would truncate every cue
   * in the file to its source and quietly hand back a monolingual export in the
   * wrong language.
   *
   * The untranslated line is the case this option exists to get right — the
   * existing fallback would otherwise print the source twice. See
   * `bilingualText`.
   */
  includeSource?: boolean
  /**
   * Name the speaker for a cell directly, instead of looking the cell up in
   * the project's cast assignments.
   *
   * REQUIRED FOR EXPORTING AUDIO CUES, and the reason is a trap this codebase
   * has now hit three times. `assignedCastVoiceId` reads
   * `settings.castAssignments`, which is keyed by cell id — and an audio cue
   * only gets an entry there if the AUDIO character sheet was imported. Import
   * only the subtitle sheet and every cue looks anonymous, so a voice-tagged
   * export of the cue file comes out completely bare while the app itself
   * shows names everywhere (they resolve across the cue↔text links; see
   * `lib/timeline/cue-character.ts`). `audio-by-character.ts` carries the same
   * parameter for the same reason.
   *
   * Returning null or an empty string means "nobody is named", which leaves
   * the cue untagged rather than tagging it with a blank.
   */
  resolveName?: (cell: CellData) => string | null
}

/** One cue's worth of resolved content, before it is serialized. */
interface Unit {
  startTime: number
  endTime: number
  /**
   * More than one line whenever cue splitting stacks two speakers, or the
   * bilingual option pairs a source with its target.
   *
   * Never a blank line in the MIDDLE of it — an empty line ends the cue, so
   * everything below one would be lost. It may END in one: that is a bilingual
   * cue whose target has not been written yet, and there is nothing under it
   * left to lose.
   */
  payload: string
}

/**
 * The two lines of a bilingual cue: what was said, then what it became.
 *
 * THE UNTRANSLATED LINE IS WHY THIS FUNCTION EXISTS. A monolingual export falls
 * back to the source text when a cell has no translation yet — Matecat-style
 * draft behaviour, shared with the SRT exporter — which is right for a file
 * somebody has to be able to watch. Carried into a bilingual cue unchanged,
 * that fallback prints the same sentence twice, one line above the other. It
 * reads as a bug in the exporter, and it hides the single thing a reviewer
 * opens this file to find out: which lines nobody has done yet. So an
 * untranslated line is written as its source and then an EMPTY target line. The
 * gap is the same on every untranslated line in the file, which makes them
 * countable by eye as the film runs.
 *
 * Whether a line is translated is decided from `cell.translated` being empty,
 * not by comparing the two strings. Comparing would also catch the fallback,
 * but it would collapse lines whose translation legitimately IS the source — a
 * name, a number, "Amen" — and report finished work as missing.
 *
 * `stripHtml` runs over each side separately because it collapses runs of
 * whitespace: over the joined pair it would eat the newline holding them apart.
 */
function bilingualText(cell: CellData, monolingual: string): string {
  const source = stripHtml(effectiveSourceText(cell) || "")
  // No source text to sit above anything. An untranscribed media section has
  // none at all by design (see `effectiveSourceText`), and a leading empty line
  // there would say "untranslated" about the wrong half of the pair, so the cue
  // keeps exactly the shape it has today.
  if (!source) return monolingual
  // AN UNTRANSLATED LINE IS THE SOURCE ALONE, with no second line at all.
  //
  // The first cut appended an empty target line, on the reasoning that a
  // visible gap says "nothing here yet". It does not: a blank line TERMINATES a
  // cue, so the empty half was never rendered by anything — it only left a
  // stray extra newline in the file, and cues with an inconsistent number of
  // blank lines after them is exactly the sort of thing that makes a subtitle
  // tool look at a file twice. Source-only already reads as untranslated, and
  // the alternative — writing "[untranslated]" — would be fake text on screen,
  // which this exporter refuses everywhere else too.
  const translated = cell.translated ? stripHtml(cell.translated) : ""
  return translated ? `${source}\n${translated}` : source
}

function unitsFrom(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
  options: VttExportOptions,
): Unit[] {
  const excludeLabels = options.excludeLabels === true
  const units: Unit[] = []
  for (const cell of sortedByTime(cells)) {
    if (cell.startTime == null || cell.endTime == null) continue
    const raw = (cell.translated || effectiveSourceText(cell) || "").trim()
    // A line someone added into a silence keeps its cue even with nothing
    // written in it yet — it may carry a recording, and its TIMING is real
    // work that the file has to preserve either way (Sam, 2026-08-12: a blank
    // text line, never a placeholder, which would be fake text that could
    // reach a screen). An imported cue with no text is still skipped: that is
    // an untranslated line, not a deliberately silent one.
    if (!raw && !isUserAddedLine(cell)) continue
    // `raw` alone still decides which cells get a cue at all, so turning the
    // bilingual option on never adds or removes a line — it only changes what
    // is written inside the cues that were always going to be there.
    const monolingual = raw ? stripHtml(raw) : ""
    const text = options.includeSource === true ? bilingualText(cell, monolingual) : monolingual
    // The resolver wins when it has an answer, and falls back to the cast
    // assignments when it does not — so passing one can only ever ADD tags,
    // never take away a tag the settings would have produced.
    const resolved = excludeLabels ? null : options.resolveName?.(cell)?.trim() || null
    const voiceId = excludeLabels || resolved ? undefined : assignedCastVoiceId(settings, cell.id)
    const assigned = voiceId ? findVoice(settings, voiceId) : undefined
    const speaker = resolved ?? assigned?.name ?? null
    units.push({
      startTime: cell.startTime,
      endTime: cell.endTime,
      // The tag wraps the WHOLE payload, both languages — one speaker said both
      // lines, and closing it after the source would leave the target
      // unattributed. It closes on the line below, which is also what keeps an
      // untranslated bilingual cue safe to stack: its last line is `</v>`
      // rather than an empty string, so it cannot terminate a cue early.
      payload: speaker ? `<v ${escapeVoiceName(speaker)}>${text}</v>` : text,
    })
  }
  return units
}

/**
 * Re-cut the cues so none of them overlap.
 *
 * Every unique start and end becomes a boundary; each adjacent pair becomes one
 * cue carrying every line active across that span. A line spanning three
 * boundaries therefore appears in three cues — that is the trade cue splitting
 * makes, and it is why this is not the default.
 *
 * Payloads are joined with a SINGLE newline: a blank line inside a cue
 * terminates it per the WebVTT spec, so "\n\n" here would silently truncate
 * every stacked cue to its first speaker.
 */
function splitCues(units: Unit[]): Unit[] {
  const boundaries = new Set<number>()
  for (const u of units) {
    boundaries.add(u.startTime)
    boundaries.add(u.endTime)
  }
  const sorted = [...boundaries].sort((a, b) => a - b)
  const out: Unit[] = []
  // A CUE WITH NO DURATION CANNOT BE SPLIT, and must not be lost trying.
  // Boundary spans are half-open, so a cue where start === end is active across
  // none of them and simply vanished — a silent deletion from an export, which
  // is the one thing a subtitle file must never do. They pass through as they
  // are and get sorted back into place below.
  for (const unit of units) {
    if (unit.startTime === unit.endTime && unit.payload !== "") out.push(unit)
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i]!
    const end = sorted[i + 1]!
    // Active across [start, end): strictly inside, so a cue that merely touches
    // this span at a boundary is not counted.
    const active = units.filter((u) => u.startTime < end && u.endTime > start)
    if (active.length === 0) continue // a real silence between lines
    const payload = stacked(active)
    // Every line in this span was blank — there is nothing to show, and an
    // empty cue is not a cue.
    if (payload === "") continue
    out.push({ startTime: start, endTime: end, payload })
  }
  // The pass-through cues above were appended out of order.
  out.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
  return out
}

/**
 * Lay the lines active across one span out under each other in a single cue.
 *
 * Single newlines, for the reason above — plus one extra care the bilingual
 * option forces. An untranslated bilingual line ends in an empty target line,
 * which is harmless as the last thing in a cue of its own but fatal in the
 * middle of a stack: it ends the cue, and every speaker below it disappears
 * from the overlap. Where lines stack, that trailing blank goes and the
 * untranslated line shows as its source alone.
 *
 * Keeping the blank for whichever speaker happened to land last would preserve
 * more, but then the same line would render one way in one cue and another way
 * in the next as the stack changed around it — worse to read than a shape that
 * is always the same. A line with a voice tag never reaches this at all: its
 * payload ends in `</v>`, not in an empty line.
 */
function stacked(active: Unit[]): string {
  if (active.length === 1) return active[0]!.payload
  // A UNIT WITH NO TEXT AT ALL IS DROPPED FROM THE STACK, not joined as an
  // empty string. Trimming trailing newlines is not enough: a deliberately
  // blank user-added line has an EMPTY payload, and joining it puts a blank
  // line at the top or the middle of the cue — which terminates the cue, so
  // every speaker stacked below it silently disappears from the file. That is
  // strictly worse than the blank line not being represented, which is the
  // most a stacked cue could have said about it anyway.
  const written = active.map((u) => u.payload.replace(/\n+$/, "")).filter((text) => text !== "")
  return written.join("\n")
}

/** WEBVTT export. Each timed cell becomes a cue; cells explicitly assigned to a
 *  Cast member get a `<v Name>` voice tag (default-only/unassigned cells stay
 *  plain — matching codex-editor). Cells without timecodes are skipped. */
export function exportVtt(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
  options: VttExportOptions = {},
): Blob {
  const units = unitsFrom(cells, settings, options)
  const final = options.cueSplitting ? splitCues(units) : units
  const cues = final.map((u) => `${formatVttTime(u.startTime)} --> ${formatVttTime(u.endTime)}\n${u.payload}`)
  const body = cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n"
  return new Blob([body], { type: "text/vtt;charset=utf-8" })
}
