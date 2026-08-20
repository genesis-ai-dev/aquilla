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
import { withBwfTimestamp } from "./audio-bwf"
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
): PerLineClip[] {
  const ordered = [...cells].sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity))
  const clips: PerLineClip[] = []
  let line = 0
  for (const cell of ordered) {
    line += 1
    const audioId = cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId
    if (!audioId) continue
    const url = cell.attachments?.[audioId]?.url
    if (!url) continue
    // Same identity rule as the per-character export, so the two deliverables
    // and the preview cannot name the same line three different ways.
    const identity = characterIdentity(cell, settings, resolveName)
    clips.push({
      cellId: cell.id,
      audioId,
      url,
      lineNumber: line,
      character: identity.name,
      startSec: cell.startTime ?? null,
      endSec: cell.endTime ?? null,
    })
  }
  return clips
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
export function buildManifestCsv(rows: { name: string; clip: PerLineClip }[]): string {
  const header = "file,line,character,start,end,start_seconds,end_seconds,cell_id"
  const body = rows.map(({ name, clip }) =>
    [
      csvCell(name),
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
}

export async function exportAudioPerLine(
  args: ExportPerLineArgs,
): Promise<{ blob: Blob; files: number; clips: number; skipped: number; untimed: number }> {
  const clips = collectPerLineClips(args.cells, args.settings, args.resolveName)
  const zip = new JSZip()
  const manifest: { name: string; clip: PerLineClip }[] = []
  const cellById = new Map(args.cells.map((c) => [c.id, c]))
  const used = new Set<string>()
  let done = 0
  let skipped = 0
  let untimed = 0

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
      const generated = clip.audioId === cell.selectedGeneratedVoiceAudioId
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
        // Untouched audio, one chunk richer. A non-WAV comes back unchanged
        // and travels on the manifest alone.
        bytes = withBwfTimestamp(bytes, {
          // A hyphen, not an em dash: the bext fields are Latin-1 and the
          // writer turns anything above 0xFF into "?", so the pretty dash came
          // out as "NICODEMUS ? line 117" in the delivered files.
          description: `${clip.character} - line ${clip.lineNumber}`,
          originator: "Aquilla",
          originatorRef: clip.cellId,
          timeReferenceSamples: clip.startSec * BWF_RATE,
        })
      }

      let name = perLineFileName(clip, ext, { fileBase: args.fileBase, langCode: args.langCode })
      // Two takes on one line, or two lines claiming one shared clip: keep both
      // rather than letting the second overwrite the first silently.
      if (used.has(name)) {
        const dot = name.lastIndexOf(".")
        let n = 2
        let candidate = `${name.slice(0, dot)}_${n}${name.slice(dot)}`
        while (used.has(candidate)) {
          n += 1
          candidate = `${name.slice(0, dot)}_${n}${name.slice(dot)}`
        }
        name = candidate
      }
      used.add(name)
      zip.file(name, bytes)
      manifest.push({ name, clip })
    } catch (err) {
      console.warn(`[audio-per-line] skipping ${clip.audioId} (${clip.cellId}):`, err)
      skipped += 1
    }
    done += 1
    args.onProgress?.(done, clips.length)
  }

  if (manifest.length > 0) zip.file("manifest.csv", buildManifestCsv(manifest))
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" })
  return { blob, files: manifest.length, clips: clips.length, skipped, untimed }
}
