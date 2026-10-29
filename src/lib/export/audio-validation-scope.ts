// AQU-965: WHAT AN AUDIO EXPORT IS ALLOWED TO SHIP.
//
// `validation-scope.ts` decides this for text and has since AQU-1148. Audio
// never asked: the four audio deliverables read `selectedAudioId ??
// selectedGeneratedVoiceAudioId` off each cell and wrote whatever was there,
// so a dubbing export went to the studio with every line unvalidated and
// nobody was told (Come and See, 2026-08-19). This module is the audio half of
// that same decision, and it answers two questions:
//
//   - `unvalidatedAudioLineIds` — WHICH LINES WOULD SHIP AN UNVALIDATED TAKE.
//     The Export dialog shows the count before the export runs, which is the
//     half of the fix that applies in every mode: the failure above was not
//     that the export ran, it was that it ran silently.
//   - `scopeAudioCellsForExport` — under `validated-only`, the cells with
//     those takes withdrawn, so the deliverable carries only signed-off audio.
//
// WHAT "WITHDRAWN" MEANS IS PER DELIVERABLE, and deliberately so (the product
// call recorded on AQU-965, consistent with the text mode):
//
//   - the per-line zip simply has no file for that line — the omission is the
//     absence, exactly as an unrecorded line's is;
//   - by character and the egress assembly lay takes on a silent timeline at
//     their own second, so withdrawing one leaves SILENCE IN PLACE and every
//     other take keeps its position;
//   - the chapter stitch concatenates, so silence in place has to be written:
//     `audio-chapter.ts` emits a gap the length of the withdrawn take rather
//     than closing it up and shortening the chapter.
//
// So this module does not drop anything itself. It MARKS the take —
// `silencedForExport` on the attachment, which keeps the url, duration and
// trim window the chapter stitch needs to size its gap — and each exporter
// says in its own code what it does with a marked take. A single "filter the
// cells" step would have been smaller and would have silently chosen "closed
// up" for the two deliverables where that is the wrong answer.
//
// "Validated" is read through `isTakeValidated` against the project's AUDIO
// threshold (`readValidationCountAudio`), and the take set through
// `selectedDubTakes` — the same two the line's audio control draws from, so
// the dialog's count and the gutter's ticks cannot disagree. In particular
// only SELECTED takes count (the one that plays is the one that exports) and
// only DUB takes: a media file's imported programme audio is selected on every
// cell, carries no votes and is not somebody's unvalidated recording.
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import { audioEntryFromCell } from "@/lib/audio/audio-validation-permissions"
import { isTakeValidated, selectedDubTakes, selectedPieceIds } from "@/lib/sync/cell-audio-read-types"
import type { ExportContentMode } from "./validation-scope"

/** The cell fields this module reads. `CellData` satisfies it; so does the
 *  attachment-merged audio-cue row, which is what a dubbing file exports. */
export interface AudioScopableCell {
  id: string
  attachments?: Record<string, CodexCellAttachment>
  selectedAudioId?: string
  selectedGeneratedVoiceAudioId?: string
  selectedBySlot?: Record<string, string>
}

/** One take that would reach the deliverable, and its votes. */
export interface ShippingTake {
  audioId: string
  attachment: CodexCellAttachment
}

/**
 * The takes this line would actually ship, one per track.
 *
 * `selectedDubTakes` resolves the selection exactly as the line's audio check
 * does — the default track's two slots collapsed to the one that sounds, one
 * take per added track, programme audio excluded. A selected take with no url
 * is then dropped: every exporter requires one, so counting it would warn
 * about audio no export was going to write.
 */
export function shippingDubTakes(cell: AudioScopableCell): ShippingTake[] {
  const entry = audioEntryFromCell(cell)
  if (!entry) return []
  const takes: ShippingTake[] = []
  for (const take of selectedDubTakes(entry)) {
    const attachment = cell.attachments?.[take.audioId]
    if (!attachment?.url) continue
    takes.push({ audioId: take.audioId, attachment })
  }
  return takes
}

/**
 * The lines that would ship a take short of the project's audio threshold.
 *
 * A line counts when ANY of its shipping takes is short, which is the rule the
 * gutter already draws (`cellAudioVotes` takes the weakest): two tracks sound
 * together, so a line whose second track nobody signed off is not a validated
 * line however thoroughly the first was.
 *
 * A line with NOTHING recorded is not in here. It ships no audio, so it has no
 * unvalidated take to warn about, and the dialog already counts it separately
 * as still to record — reporting it twice would make the validation number
 * read as worse than it is.
 *
 * ON A DUBBING FILE THESE ARE THE HEARD LINES, not the subtitle rows: the
 * export is handed the audio-cue sibling's cells, which is where the takes
 * live (the same reason `lineValidationTakes` reaches for them). So a subtitle
 * line performed by cues is never reported take-less.
 */
export function unvalidatedAudioLineIds(
  cells: readonly AudioScopableCell[],
  requirement: number,
): string[] {
  const ids: string[] = []
  for (const cell of cells) {
    const takes = shippingDubTakes(cell)
    if (takes.length === 0) continue
    if (takes.some((take) => !isTakeValidated(take.attachment, requirement))) ids.push(cell.id)
  }
  return ids
}

/**
 * The take the default track SHIPS for a cell — the recording slot's when it is
 * still there, else the generated voice's. (AQU-2148)
 *
 * Every audio deliverable used to read `selectedAudioId ??
 * selectedGeneratedVoiceAudioId` and write back whatever came out. That is the
 * precedence `resolveTargetAudio` draws the timeline with, MINUS its one guard:
 * that the clip the pointer names is still live. A selection outlives its take
 * — removing a take leaves the pointer behind until something re-selects — so a
 * line whose old recording was deleted and whose new voice arrived in the
 * `generatedVoice` slot resolved to the dead id, found no attachment, and was
 * dropped from the deliverable ENTIRELY: a cell exporting silence on every
 * character track while the line's own audio control played its new take, and
 * nothing in the preview to say so (The Journey — Arabic, Joel, 2026-10-23).
 *
 * This is not a new rule. `selectedDubTakes` — what the gutter's ticks and
 * AQU-965's validated-only scope are both measured over — already falls
 * through, because `audioEntryFromCell` drops a deleted attachment before it
 * resolves. The export was the one surface still reading the raw pointers, so
 * it shipped a different take from the one every other surface named. Them
 * agreeing is the whole point.
 *
 * STRICTLY A FALL-THROUGH. A slot holding anything usable resolves to exactly
 * the id it always did, so no deliverable loses a take it ships today. Only a
 * cell that ships NOTHING today can change, and it changes to the take that
 * sounds.
 *
 * Deliberately WITHOUT `resolveTargetAudio`'s `audioIdSeededWith` dub guard.
 * That reads provenance off the id's seed and defaults an ambiguous or legacy
 * id to SOURCE, so applying it here would withdraw takes from deliverables
 * that ship them today — the opposite failure, and not this ticket's to risk.
 */
export function defaultTrackTakeId(
  cell: Pick<AudioScopableCell, "attachments" | "selectedAudioId" | "selectedGeneratedVoiceAudioId">,
): string | null {
  const usable = (audioId: string): boolean => {
    const att = cell.attachments?.[audioId]
    return Boolean(att?.url) && att?.isDeleted !== true
  }
  const live = (audioId: string | undefined): string | null => {
    if (!audioId) return null
    if (usable(audioId)) return audioId
    // AQU-1767: a cut take is several selected pieces over one recording. The
    // pointer can name a piece somebody removed while its siblings still
    // sound, and the slot still has audio to ship — so the slot is live and the
    // caller resolves the pieces as it already does.
    return selectedPieceIds(cell.attachments, audioId).some(usable) ? audioId : null
  }
  return live(cell.selectedAudioId) ?? live(cell.selectedGeneratedVoiceAudioId)
}

/**
 * True when this take was withdrawn from the export for want of validation.
 *
 * The exporters' one read of the mark, so "what does a withdrawn take look
 * like?" is answered here rather than four times over.
 */
export function isSilencedForExport(
  attachment: Pick<CodexCellAttachment, "silencedForExport"> | undefined,
): boolean {
  return attachment?.silencedForExport === true
}

/**
 * The cells an audio exporter should see.
 *
 * Under `current` this is the caller's own array, by identity — today's
 * exports stay byte-identical, and so does a fully-validated file's in either
 * mode. Under `validated-only` every shipping take short of the threshold is
 * marked; the cells are copied rather than mutated, because the previews and
 * the dialog's counts read the caller's array and must keep describing what
 * the file actually holds.
 */
export function scopeAudioCellsForExport<C extends AudioScopableCell>(
  cells: C[],
  mode: ExportContentMode,
  requirement: number,
): C[] {
  if (mode !== "validated-only") return cells
  const silenced = new Map<string, string[]>()
  for (const cell of cells) {
    const short = shippingDubTakes(cell)
      .filter((take) => !isTakeValidated(take.attachment, requirement))
      .map((take) => take.audioId)
    if (short.length > 0) silenced.set(cell.id, short)
  }
  if (silenced.size === 0) return cells
  return cells.map((cell) => {
    const short = silenced.get(cell.id)
    if (!short) return cell
    const attachments: Record<string, CodexCellAttachment> = { ...cell.attachments }
    for (const audioId of short) {
      attachments[audioId] = { ...attachments[audioId], silencedForExport: true }
    }
    return { ...cell, attachments }
  })
}
