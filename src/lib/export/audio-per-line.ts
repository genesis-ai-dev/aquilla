// Client-side export: one file per recording, named by line and character.
// (AQU-646, 2026-08-18)
//
// The SECOND of codex-editor's two audio shapes, and the one aquilla was
// missing. Sam, weighing them: "Are you sure it's supposed to be one audio file
// and not a separate track for each recording? With timing data?"
//
// Both are right, for different jobs. `audio-by-character.ts` builds one track
// per character with every take at its timeline second on silence — the
// deliverable for whoever MIXES the episode. This is the deliverable for
// whoever REVIEWS it: one file per line, so a director can listen through, mark
// three takes for re-recording and hand those three back, without anybody
// cutting a forty-minute track apart.
//
// It carries its timing three ways, because different tools read different
// things and a folder of audio files is otherwise silent about where anything
// belongs:
//
//   - in the FILENAME, as the line number, which is what a person reads;
//   - in the WAV itself, as a BWF timestamp a DAW can place from (see
//     `audio-bwf.ts`) — for takes that are WAVs, which recordings and the
//     lossless generated siblings both are;
//   - in a MANIFEST, which covers every file including the webm ones and is
//     the only form a spreadsheet or a script can read without parsing audio.
//
// Deliberately NO decoding. The character export has to decode because it
// resamples everything onto one timeline; this one copies the stored bytes
// untouched, so it is lossless by construction and fast enough to run on an
// episode with six hundred takes.

import JSZip from "jszip"

import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import { isDefaultTrackSlot, slotForTrack } from "@/lib/timeline/track-slots"
import type { TimelineTrack } from "@/lib/timeline/tracks"
import { trimWav, withBwfTimestamp } from "./audio-bwf"
import { targetChipGeom } from "@/lib/timeline/lane-timing"
import {
  characterFileKey,
  characterIdentity,
  characterKey,
  type ResolveCharacterName,
} from "./audio-by-character"

/** Sample rate the BWF timestamp is expressed in. The stored WAVs are written
 *  at this rate by the recorder and the offline encoder alike. */
const BWF_RATE = 48000

export interface PerLineClip {
  cellId: string
  audioId: string
  url: string
  /** 1-based position of this line in the file, in time order. */
  lineNumber: number
  character: string
  startSec: number | null
  endSec: number | null
  /**
   * AQU-646 stage 4: which TRACK this take is on.
   *
   * Absent on every single-track export, which is what keeps the classic zip
   * byte-identical — see `exportAudioPerLine`. Present, it is the folder the
   * file goes in and a column in the manifest.
   */
  trackId?: string
  trackName?: string
  /** True when the take is a generated voice, which decides whether the
   *  lossless WAV sibling is worth asking for. On the default track this is
   *  `selectedGeneratedVoiceAudioId`; on an added track the slot holds recorded
   *  and generated alike, so it comes off the attachment's `voiceId` — the
   *  discriminator stage 3 verified against all three synthesis paths. */
  generated?: boolean
}

/**
 * Every recording in the file, in the order they are heard.
 *
 * Line numbers count ALL timed lines, not just the recorded ones, so L047 is
 * the forty-seventh line of the episode whichever of its neighbours happen to
 * have been recorded yet. Numbering only the recorded ones would renumber the
 * whole export every time someone records another take, which makes the files
 * impossible to talk about across two exports.
 */
export function collectPerLineClips(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
  resolveName?: ResolveCharacterName,
  /**
   * AQU-646 stage 4: the file's tracks, when it has more than the derived ones.
   *
   * ABSENT ⇒ EXACTLY THE OLD BEHAVIOUR, one clip per line off the default
   * track's two slots. That is not politeness to callers, it is what keeps a
   * single-track project's zip byte-identical to the one it gets today.
   *
   * Present, every audio track is enumerated: the derived dub row through the
   * same two slots as before, and each added track through
   * `selectedBySlot[track.id]` — an added track's slot IS its id, and holds its
   * recorded and generated takes alike (`track-slots.ts`).
   */
  tracks?: readonly TimelineTrack[],
): PerLineClip[] {
  const ordered = [...cells].sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity))
  const audioTracks = tracks?.filter((t) => t.kind === "target-audio" || t.kind === "audio") ?? []
  const clips: PerLineClip[] = []
  let line = 0
  for (const cell of ordered) {
    // NUMBERED PER FILE, NEVER PER TRACK. L047 has to mean the forty-seventh
    // line of the episode in every folder, or the folders cannot be talked
    // about together — "L047 in Spanish" would name a different line from
    // "L047 in Target audio", which is exactly what the numbering exists to
    // prevent across two exports a week apart.
    line += 1
    // Same identity rule as the per-character export, so the two deliverables
    // and the preview cannot name the same line three different ways.
    const identity = characterIdentity(cell, settings, resolveName)
    const base = {
      cellId: cell.id,
      lineNumber: line,
      character: identity.name,
      startSec: cell.startTime ?? null,
      endSec: cell.endTime ?? null,
    }

    if (audioTracks.length === 0) {
      const audioId = cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId
      if (!audioId) continue
      const url = cell.attachments?.[audioId]?.url
      if (!url) continue
      clips.push({
        ...base,
        audioId,
        url,
        generated: audioId === cell.selectedGeneratedVoiceAudioId,
      })
      continue
    }

    for (const track of audioTracks) {
      const isDefault = isDefaultTrackSlot(slotForTrack(track.id))
      const audioId = isDefault
        ? (cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId)
        : cell.selectedBySlot?.[track.id]
      if (!audioId) continue
      const attachment = cell.attachments?.[audioId]
      if (!attachment?.url) continue
      clips.push({
        ...base,
        audioId,
        url: attachment.url,
        trackId: track.id,
        trackName: track.name,
        // On the default row the pointer names it; on an added track the one
        // slot holds both kinds, so the take itself has to say.
        generated: isDefault
          ? audioId === cell.selectedGeneratedVoiceAudioId
          : attachment.voiceId != null,
      })
    }
  }
  return clips
}

/**
 * The folder a track's files go in, sanitised and unique.
 *
 * `characterFileKey` is the sanitiser character names already use, so one rule
 * covers both and a track called "Español (M)" cannot produce a name a zip
 * refuses. De-duplicated because track names are free text and REPEAT in
 * practice — the client's own test file carries two tracks both called "Audio",
 * and without this the second would silently overwrite the first's whole
 * folder.
 *
 * THE DE-DUPLICATION FOLDS CASE; THE NAME DOES NOT (2026-08-27). A zip may hold
 * "Spanish/" and "spanish/" quite legally, and macOS and Windows then merge
 * them on extraction and drop one line's take per collision — the exact loss
 * this exists to prevent, arrived at the long way round. Only the uniqueness
 * check is case-blind: lowercasing the name itself would rename every folder
 * that already ships and break its agreement with the character filenames,
 * which one of these tests pins. Same shape as `sanitizeSheetNames`, which
 * folds case for Excel's tab rule and leaves the tab name alone.
 */
export function trackFolderNames(tracks: readonly { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const track of tracks) {
    // No `|| "track"` fallback: `characterKey` already ends in `|| "unnamed"`,
    // so this cannot be empty and that arm was never reachable.
    const base = characterFileKey(track.name)
    let name = base
    let n = 2
    while (used.has(name.toLowerCase())) {
      name = `${base}_${n}`
      n += 1
    }
    used.add(name.toLowerCase())
    out.set(track.id, name)
  }
  return out
}

/** `episode_es_L047_JESUS.wav` — the line number BEFORE the character, so the
 *  folder sorts into playing order rather than into alphabetical clumps. */
export function perLineFileName(
  clip: PerLineClip,
  ext: string,
  opts: { fileBase?: string; langCode: string },
): string {
  const stem = opts.fileBase ? `${characterKey(opts.fileBase)}_` : ""
  const line = String(clip.lineNumber).padStart(4, "0")
  return `${stem}${opts.langCode}_L${line}_${characterFileKey(clip.character)}.${ext}`
}

function csvCell(value: string | number | null): string {
  if (value == null) return ""
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Seconds as `HH:MM:SS.mmm`, the form every subtitle and edit tool reads. */
export function timecode(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return ""
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = ms % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(rest, 3)}`
}

/**
 * The sidecar. Written for EVERY export, not only when something is unusual:
 * it is the one artefact that survives a rename, opens in a spreadsheet, and
 * says what a folder of audio files cannot.
 */
export function buildManifestCsv(
  rows: { name: string; clip: PerLineClip }[],
  /**
   * Did the archive get folders? THE SIDECAR DESCRIBES THE ARCHIVE, so this is
   * handed down rather than worked out again here (2026-08-27).
   *
   * It used to be re-derived as "does any clip name a track", which is a
   * different question from the one the zip asks ("did more than one track
   * contribute"), and in production the two always disagreed: the dialog always
   * passes `tracks`, every file has a derived `target-audio` row, and every
   * clip is stamped with its track — so an ordinary single-track project got a
   * FLAT zip and a WIDENED nine-column manifest naming "Target audio" on every
   * row. Exactly the silent schema change the note below forbids. Two
   * predicates that must agree are one predicate, passed.
   */
  foldered: boolean,
): string {
  // THE COLUMN APPEARS ONLY WHEN THERE ARE TRACKS TO NAME. A single-track
  // export's CSV keeps the exact schema it has always had, because something
  // downstream is reading it by position and a silently widened header is the
  // rudest possible change to a sidecar.
  const header = foldered
    ? "file,track,line,character,start,end,start_seconds,end_seconds,cell_id"
    : "file,line,character,start,end,start_seconds,end_seconds,cell_id"
  const body = rows.map(({ name, clip }) =>
    [
      csvCell(name),
      // The REAL track name, not the sanitised folder: the sidecar is where the
      // name someone typed survives a filesystem that could not hold it.
      ...(foldered ? [csvCell(clip.trackName ?? "")] : []),
      csvCell(clip.lineNumber),
      csvCell(clip.character),
      csvCell(timecode(clip.startSec)),
      csvCell(timecode(clip.endSec)),
      csvCell(clip.startSec),
      csvCell(clip.endSec),
      csvCell(clip.cellId),
    ].join(","),
  )
  return [header, ...body].join("\n") + "\n"
}

export interface ExportPerLineArgs {
  cells: CellData[]
  settings: ProjectTtsSettings | undefined
  projectId: string
  langCode: string
  fileBase?: string
  fetchBytes: (args: { projectId: string; fileId: string; audioId: string; ext: string }) => Promise<Uint8Array>
  onProgress?: (done: number, total: number) => void
  resolveName?: ResolveCharacterName
  /** AQU-646 stage 4: the file's tracks. Absent ⇒ the single-track export,
   *  unchanged down to the zip entry names. */
  tracks?: readonly TimelineTrack[]
}

export async function exportAudioPerLine(
  args: ExportPerLineArgs,
): Promise<{ blob: Blob; files: number; clips: number; skipped: number; untimed: number; untrimmed: number }> {
  const clips = collectPerLineClips(args.cells, args.settings, args.resolveName, args.tracks)
  const zip = new JSZip()
  const manifest: { name: string; clip: PerLineClip }[] = []
  const cellById = new Map(args.cells.map((c) => [c.id, c]))
  const used = new Set<string>()
  // ONE FOLDER PER TRACK (Sam, 2026-08-26), and only when a track actually
  // contributed a take. A file with added tracks that nobody has recorded onto
  // still produces the flat classic zip, because a folder holding one thing —
  // or holding everything, with empty siblings — is a worse deliverable than
  // the one this replaced.
  const contributing = args.tracks?.filter((t) => clips.some((c) => c.trackId === t.id)) ?? []
  const folders = contributing.length > 1 ? trackFolderNames(contributing) : new Map<string, string>()
  let done = 0
  let skipped = 0
  let untimed = 0
  // Takes that carry a trim this exporter could not apply — every non-WAV.
  // Reported rather than swallowed: the file is longer than the line sounds.
  let untrimmed = 0

  for (const clip of clips) {
    const parsed = parseFrontierAudioUrl(clip.url)
    if (!parsed) {
      skipped += 1
      done += 1
      args.onProgress?.(done, clips.length)
      continue
    }
    const cell = cellById.get(clip.cellId)!
    try {
      // Lossless preference, same rule as the character export: a generated
      // voice keeps its original WAV as an unattached sibling under the same
      // id, and an export must never hand over the lossy copy.
      // Off the CLIP, not the cell's default-track pointer: an added track's one
      // slot holds recorded and generated takes alike, so the pointer describes
      // a different track entirely and would call every added-track take
      // "recorded" — handing over the lossy webm where a lossless WAV sibling
      // exists.
      const generated = clip.generated === true
      let bytes: Uint8Array | null = null
      let ext = parsed.ext
      if (generated && parsed.ext === "webm") {
        bytes = await args
          .fetchBytes({ projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: "wav" })
          .catch(() => null)
        if (bytes && bytes.length > 0) ext = "wav"
        else bytes = null
      }
      if (bytes == null) {
        bytes = await args.fetchBytes({
          projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: parsed.ext,
        })
      }
      if (bytes.length === 0) throw new Error("empty audio")

      if (clip.startSec == null) untimed += 1
      else {
        // WHERE THE TAKE SITS, NOT WHERE ITS LINE STARTS.
        //
        // Stage 3 moved placement onto the take (`targetOffsetMs`, with the
        // cell's own offset as the permanent fallback for takes made before
        // there was anywhere else to put one), and this went on stamping
        // `cell.startTime` — so a chip somebody dragged exported at the
        // position it USED to have. `targetChipGeom` is the same resolver the
        // lane draws with, so the DAW and the timeline now agree by
        // construction rather than by coincidence.
        const attachment = cell.attachments?.[clip.audioId]
        const geom = targetChipGeom(cell, attachment)
        const placeSec = geom?.start ?? clip.startSec
        // …AND WHAT IT PLAYS, NOT EVERYTHING THAT WAS RECORDED (2026-08-27).
        //
        // `placeSec` is the take's AUDIBLE start — anchor plus head trim — so
        // handing over the untrimmed bytes stamped with it put the line into a
        // DAW late by exactly that trim, with the material the trim hides
        // audible in front of it. And this is the ordinary case, not a rare
        // one: `take-margins.ts` gives every recorded take a head trim at
        // birth to undo the pre-roll anchor shift.
        //
        // Sam's ruling: an export contains what you hear. A PCM WAV can be cut
        // by byte range with no decoder, which keeps this file's no-decoding
        // charter intact. Anything else — a webm mic take, an uploaded mp3 —
        // comes back untouched and is counted below, because those carry no
        // embedded timestamp at all and travel on the manifest.
        const before = bytes
        bytes = trimWav(bytes, {
          trimStartMs: attachment?.trimStartMs,
          trimEndMs: attachment?.trimEndMs,
        })
        const wanted = attachment?.trimStartMs != null || attachment?.trimEndMs != null
        if (wanted && bytes === before) untrimmed += 1
        bytes = withBwfTimestamp(bytes, {
          // A hyphen, not an em dash: the bext fields are Latin-1 and the
          // writer turns anything above 0xFF into "?", so the pretty dash came
          // out as "NICODEMUS ? line 117" in the delivered files.
          description: `${clip.character} - line ${clip.lineNumber}`,
          originator: "Aquilla",
          originatorRef: clip.cellId,
          timeReferenceSamples: placeSec * BWF_RATE,
        })
      }

      const folder = clip.trackId ? folders.get(clip.trackId) : undefined
      let name = perLineFileName(clip, ext, { fileBase: args.fileBase, langCode: args.langCode })
      // Prefixed BEFORE the collision check, so `used` keys on the full path:
      // two tracks may legitimately hold the same line's take under the same
      // file name, and those are different files rather than a collision.
      if (folder) name = `${folder}/${name}`
      // Two takes on one line, or two lines claiming one shared clip: keep both
      // rather than letting the second overwrite the first silently.
      // Case-blind, for the reason `trackFolderNames` gives: two paths that
      // differ only by case are one path once the zip is unpacked.
      if (used.has(name.toLowerCase())) {
        const dot = name.lastIndexOf(".")
        let n = 2
        let candidate = `${name.slice(0, dot)}_${n}${name.slice(dot)}`
        while (used.has(candidate.toLowerCase())) {
          n += 1
          candidate = `${name.slice(0, dot)}_${n}${name.slice(dot)}`
        }
        name = candidate
      }
      used.add(name.toLowerCase())
      zip.file(name, bytes)
      manifest.push({ name, clip })
    } catch (err) {
      console.warn(`[audio-per-line] skipping ${clip.audioId} (${clip.cellId}):`, err)
      skipped += 1
    }
    done += 1
    args.onProgress?.(done, clips.length)
  }

  // The same `folders` the zip was built from — see `buildManifestCsv`.
  if (manifest.length > 0) zip.file("manifest.csv", buildManifestCsv(manifest, folders.size > 0))
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" })
  return { blob, files: manifest.length, clips: clips.length, skipped, untimed, untrimmed }
}
