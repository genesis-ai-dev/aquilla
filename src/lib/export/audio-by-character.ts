// Client-side export: one track per character, every take sitting at its own
// place on the timeline, zipped.
//
// WHAT THIS USED TO BE, and why it changed (Sam, 2026-08-18: "what it is right
// now is definitely not sufficient for what it's supposed to be"). It used to
// CONCATENATE each character's takes — forty minutes of Nicodemus glued end to
// end, with no way to tell which line is which or where any of it belongs.
// That is not a dubbing deliverable; it is an audio scrapbook.
//
// The shape it should have had already existed in codex-editor
// (`src/exportHandler/characterAudioExporter.ts`), which builds each character
// on a bed of silence with every clip delayed to its cell's start time, starts
// every file at 0:00 so they drop into a DAW already aligned, and trims to that
// character's last spoken line. This is that, minus ffmpeg: we have no binary
// in a browser, so the placement happens in PCM — which costs nothing, because
// every clip is already decoded to mono at the same 48 kHz codex renders at.
//
// Memory is the one real constraint ffmpeg saved them from. A character who
// speaks once at minute forty still implies a forty-minute track, so characters
// are rendered ONE AT A TIME, straight into 16-bit, and handed to the zip as a
// Blob before the next begins.
//
// Pure functions (grouping, preview, placement) are unit-testable in happy-dom.
// The orchestrator takes an injected decode/fetch so tests can supply fakes;
// production wires real Web Audio + sync-worker fetch.

import JSZip from "jszip"
import { resolvePcmWindow } from "@/lib/audio/pcm-window"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { assignedCastVoiceId, resolveCastVoice } from "@/lib/audio/voices"
import { targetChipGeom } from "@/lib/timeline/lane-timing"
import { encodeWavPcm16Chunks, quantisePcm16, type Pcm16Chunk } from "@/lib/audio/wav-encode"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import { TARGET_RATE } from "@/lib/audio/decode-mono"

export interface CharacterClip {
  cellId: string
  audioId: string
  /** frontier-audio:// URL on the chosen attachment. */
  url: string
  /**
   * Where this take belongs on the episode's timeline, in seconds.
   *
   * null means the cell has no start time — an untimed line, which CANNOT be
   * placed. It is counted and reported rather than dropped in silence or, as
   * the old concatenating export did, glued on somewhere it does not belong.
   */
  startSec: number | null
  /** The cue's own end, when it has one. Used only to decide where a
   *  character's track stops. */
  endSec: number | null
  /**
   * This cell's window into the clip, in ms (2026-08-27).
   *
   * Carried because the mix must contain what the timeline PLAYS: `startSec`
   * is the audible start, so laying the whole recording there put every take
   * late by its head trim — and `take-margins.ts` gives essentially every
   * recorded take one at birth. It is also what distinguishes two cells that
   * share one imported clip: same `audioId`, different slice.
   */
  trimStartMs?: number | null
  trimEndMs?: number | null
}

export interface CharacterGroup {
  /** Stable identity for the group — the resolved character name when there is
   *  one, else the voice id. */
  key: string
  /** What the character is CALLED. This is what names the file in the zip. */
  name: string
  color?: string
  clips: CharacterClip[]
}

export interface CharacterPreview {
  key: string
  name: string
  color?: string
  /** Lines that have a recording AND a place to put it. */
  clipCount: number
  /** Lines belonging to this character with NOTHING recorded yet. The reason
   *  this preview exists: a character who is entirely unrecorded should be
   *  visible BEFORE the export, not discovered by opening the zip. */
  missingCount: number
  /** Lines with a recording that cannot be placed, having no start time. */
  untimedCount: number
  /** Sum of known attachment durations; null when any clip lacks durationMs. */
  totalDurationMs: number | null
}

/** Pick the best-available audio for a cell: recording slot first, else
 *  generated-voice slot. Returns null when the cell has no usable audio. */
function bestAudioId(cell: CellData): string | null {
  return cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId ?? null
}

/**
 * What to call a line that nobody has cast. (AQU-646, 2026-08-20)
 *
 * `resolveCastVoice` falls back to the project's built-in Narrator for any
 * cell with no assignment, so every unlabeled line used to collect under a
 * character called **Narrator** — in the export preview, in the project report
 * Anna files per episode, and in a delivered track named `..._NARRATOR.wav`.
 * In a document about who says what, that reads as a character somebody cast,
 * and Sam flagged it on the first real report: there is no Narrator in this
 * episode.
 *
 * The label and the file-name key are separate on purpose. `characterKey()`
 * would turn the display label into `no_character_assigned`, which is a
 * mouthful in a folder of forty tracks; `NO_CHARACTER` sorts and reads better
 * beside `JESUS` and `NICODEMUS`.
 */
export const UNNAMED_CHARACTER_LABEL = "(no character assigned)"
export const UNNAMED_CHARACTER_KEY = "NO_CHARACTER"

/**
 * The character this line belongs to, and the key that groups it.
 *
 * "Nobody has cast this" is decided by the absence of an EXPLICIT assignment,
 * never by the resolved voice being the Narrator. The Narrator is editable in
 * place — a project that renames it and genuinely uses it as a character would
 * otherwise have every one of its lines filed under "no character assigned",
 * which is the same class of lie in the opposite direction.
 */
export function characterIdentity(
  cell: CellData,
  settings: ProjectTtsSettings | undefined,
  resolveName?: ResolveCharacterName,
): { key: string; name: string; color?: string } {
  const named = resolveName?.(cell)?.trim() || null
  if (named) {
    const voice = resolveCastVoice(settings, cell.id, cell.ttsSettings?.voiceId)
    return { key: named, name: named, ...(voice.color ? { color: voice.color } : {}) }
  }
  const explicit = assignedCastVoiceId(settings, cell.id) ?? cell.ttsSettings?.voiceId
  if (!explicit) return { key: UNNAMED_CHARACTER_KEY, name: UNNAMED_CHARACTER_LABEL }
  const voice = resolveCastVoice(settings, cell.id, cell.ttsSettings?.voiceId)
  return { key: voice.id, name: voice.name, ...(voice.color ? { color: voice.color } : {}) }
}

/**
 * Who a clip belongs to, named the way the rest of the app names them.
 *
 * WHY THIS IS A PARAMETER. Grouping used to go straight to `resolveCastVoice`,
 * which reads `castAssignments`. That is right when the AUDIO character sheet
 * was imported — it writes assignments for cue ids — and silently wrong when
 * only the SUBTITLE sheet was, because a cue then has no assignment of its own
 * and every take collapses into one default-voice group. The caller passes a
 * resolver that goes through the links (`lib/timeline/cue-character.ts`), which
 * is exactly what the chip strip and the recorder already do, so the zip agrees
 * with what was on screen.
 */
export type ResolveCharacterName = (cell: CellData) => string | null

export function groupAudioByCharacter(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
  resolveName?: ResolveCharacterName,
): CharacterGroup[] {
  const order: string[] = []
  const byKey = new Map<string, CharacterGroup>()

  for (const cell of cells) {
    const audioId = bestAudioId(cell)
    if (!audioId) continue
    const attachment = cell.attachments?.[audioId]
    if (!attachment?.url) continue
    // The NAME is the identity when we have one: two cells sharing a character
    // belong together even if they resolved to different voices. A line nobody
    // cast is its own group — see `characterIdentity`.
    const identity = characterIdentity(cell, settings, resolveName)
    const key = identity.key
    let group = byKey.get(key)
    if (!group) {
      group = { key, name: identity.name, ...(identity.color ? { color: identity.color } : {}), clips: [] }
      byKey.set(key, group)
      order.push(key)
    }
    // ONE CLIP, ONE PLACE. A combined "voice together" generation is attached
    // to every cell it covers under the same id, and the old export pushed it
    // once per cell — so a line recorded together with three others was
    // concatenated three times. Placed on a timeline that would be three copies
    // stacked on themselves. The earliest covering cue is where it starts.
    // …but a shared clip is only ONE place when the cells play the SAME slice
    // of it. An imported media file is attached to many cues under one id with
    // a different trim window each (`attach-media.ts`), and those are
    // genuinely different audio — collapsing them exported one cue's slice for
    // all of them (2026-08-27).
    const trimStartMs = attachment.trimStartMs ?? null
    const trimEndMs = attachment.trimEndMs ?? null
    const existing = group.clips.find(
      (c) =>
        c.audioId === audioId &&
        (c.trimStartMs ?? null) === trimStartMs &&
        (c.trimEndMs ?? null) === trimEndMs,
    )
    // WHERE THE TAKE SITS, NOT WHERE ITS LINE STARTS. (AQU-646 stage 4)
    //
    // This is the MIX deliverable — every clip laid on silence at its timeline
    // second — so reading the cell's start meant a chip somebody dragged came
    // out of the zip at the position it used to have, and the mix disagreed
    // with the timeline on screen. `targetChipGeom` is the resolver the lane
    // itself draws with (the take's own `targetOffsetMs`, falling back to the
    // cell's for takes made before there was anywhere else to put one), so the
    // two now agree by construction.
    //
    // Falls back to the cell when geometry cannot be resolved — an untimed
    // line has no section to place against, and that case is already handled
    // downstream by counting it as unplaceable.
    const geom = targetChipGeom(cell, attachment)
    const startSec = geom?.start ?? cell.startTime ?? null
    // THE CUE'S WINDOW, NOT THE TAKE'S OWN END (Sam, 2026-08-27).
    //
    // `trackDurationSec` runs a character's track to whichever is later: where
    // the audio stops, or where the last line it speaks was supposed to end.
    // The first half it computes itself from the placed audio, so this field is
    // only ever the second half — which is what the doc on `endSec` has always
    // said and what the code stopped supplying when it began reading
    // `geom.end`, the take's own audible end. Handing the take's end to both
    // halves made the comparison meaningless, and on a clip shared by several
    // cues (whose trim window can be minutes into a long import) it ran the
    // track minutes past the episode in silence.
    const endSec = cell.endTime ?? null
    if (existing) {
      if (startSec != null && (existing.startSec == null || startSec < existing.startSec)) {
        existing.startSec = startSec
      }
      if (endSec != null && (existing.endSec == null || endSec > existing.endSec)) {
        existing.endSec = endSec
      }
      continue
    }
    group.clips.push({ cellId: cell.id, audioId, url: attachment.url, startSec, endSec, trimStartMs, trimEndMs })
  }
  return order.map((k) => byKey.get(k)!)
}

/**
 * Who is in this export, and — the part that matters — who ISN'T.
 *
 * Scans EVERY cell that resolves to a character, recorded or not, which is the
 * lesson from codex-editor's preview. Grouping alone can only describe what
 * will be written, so a character with no takes at all simply vanished from the
 * list; you found out by opening the zip and noticing someone missing. Here a
 * character with nothing recorded appears with a count of zero, before the
 * export runs.
 */
export function previewAudioByCharacter(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
  resolveName?: ResolveCharacterName,
): CharacterPreview[] {
  const order: string[] = []
  const byKey = new Map<string, CharacterPreview>()
  const durationsKnown = new Map<string, boolean>()
  // Placed clips are deduped, so the counts have to be too — a combined take
  // covering four cells is ONE thing to export, not four.
  const countedClips = new Map<string, Set<string>>()

  for (const cell of cells) {
    const identity = characterIdentity(cell, settings, resolveName)
    const key = identity.key
    let row = byKey.get(key)
    if (!row) {
      row = {
        key,
        name: identity.name,
        ...(identity.color ? { color: identity.color } : {}),
        clipCount: 0,
        missingCount: 0,
        untimedCount: 0,
        totalDurationMs: 0,
      }
      byKey.set(key, row)
      order.push(key)
      durationsKnown.set(key, true)
      countedClips.set(key, new Set())
    }

    const audioId = bestAudioId(cell)
    const attachment = audioId ? cell.attachments?.[audioId] : undefined
    if (!audioId || !attachment?.url) {
      row.missingCount += 1
      continue
    }
    const seen = countedClips.get(key)!
    if (seen.has(audioId)) continue
    seen.add(audioId)

    if (cell.startTime == null) {
      row.untimedCount += 1
      continue
    }
    row.clipCount += 1
    const dur = attachment.durationMs
    if (dur == null) durationsKnown.set(key, false)
    else if (row.totalDurationMs != null) row.totalDurationMs += dur
  }

  // The uncast lines go LAST. They are not a character, so they do not belong
  // in the middle of a cast list sorted by first appearance — and a reader
  // scanning for a name should not have to step over them.
  const ordered = [
    ...order.filter((k) => k !== UNNAMED_CHARACTER_KEY),
    ...order.filter((k) => k === UNNAMED_CHARACTER_KEY),
  ]
  return ordered.map((k) => {
    const row = byKey.get(k)!
    return { ...row, totalDurationMs: durationsKnown.get(k) ? row.totalDurationMs : null }
  })
}

/** A decoded take and the second it belongs at. */
export interface PlacedClip {
  pcm: Float32Array
  startSec: number
}

/** Silence after the last take, so a lossy encoder or a player's fade cannot
 *  clip the final syllable. codex-editor pads by the same 250ms. */
export const TRACK_TAIL_PAD_SEC = 0.25

/**
 * Where a character's track has to end.
 *
 * The later of what was RECORDED and what the cue WINDOW asked for, plus the
 * pad. codex-editor clamps to the cue window instead (ffmpeg's
 * `amix duration=first`), which silently truncates a take that overran its
 * line — and losing recorded audio to save a second of silence is the wrong
 * trade in a deliverable someone is going to mix.
 */
export function trackDurationSec(
  clips: readonly { startSec: number; lengthSec: number; endSec?: number | null }[],
): number {
  let end = 0
  for (const c of clips) {
    const recorded = c.startSec + c.lengthSec
    const window = c.endSec != null && c.endSec > c.startSec ? c.endSec : 0
    end = Math.max(end, recorded, window)
  }
  return end > 0 ? end + TRACK_TAIL_PAD_SEC : 0
}

/**
 * Lay takes onto one silent track at their own timeline positions.
 *
 * THE HEART OF THE EXPORT. Every file starts at 0:00 — not at the character's
 * first line — because that is what makes the tracks drop into a DAW already
 * aligned with each other and with the film. The silence between lines is the
 * point, not waste.
 *
 * 16-bit out rather than float: it halves the peak allocation on a track that
 * can run to a hundred million samples, and the export encodes to 16-bit
 * anyway. Quantised through `quantisePcm16` so an exported take and a live one
 * of the same audio land on identical samples.
 *
 * Overlaps SUM and saturate, which is what a mixer does and what ffmpeg's
 * `amix … normalize=0` does. Two characters talking over each other is real in
 * this material; the alternative — last writer wins — would delete one of them.
 */
export function placeClips(
  clips: readonly PlacedClip[],
  durationSec: number,
  rate: number,
): Pcm16Chunk {
  const total = Math.max(0, Math.round(durationSec * rate))
  const track = new Int16Array(total)
  if (total === 0) return track
  for (const clip of clips) {
    const offset = Math.round(Math.max(0, clip.startSec) * rate)
    if (offset >= total) continue
    const n = Math.min(clip.pcm.length, total - offset)
    for (let i = 0; i < n; i += 1) {
      const at = offset + i
      const sample = track[at] + quantisePcm16(clip.pcm[i])
      // Saturating add: two loud takes over one another must not wrap round to
      // the opposite sign, which is heard as a click rather than as loudness.
      track[at] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample
    }
  }
  return track
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/** Filesystem-safe character key (mirrors codex-editor's sanitization). */
export function characterKey(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed"
}

/**
 * The file-name segment for a character, given the name shown on screen.
 *
 * Only differs from `characterKey` for the uncast lines, whose display label
 * would otherwise sanitise into `_no_character_assigned_` → a long, ugly
 * mouthful in a folder of forty tracks. `NO_CHARACTER` reads beside `JESUS`.
 */
export function characterFileKey(name: string): string {
  return name === UNNAMED_CHARACTER_LABEL ? UNNAMED_CHARACTER_KEY : characterKey(name)
}

export interface ExportAudioArgs {
  cells: CellData[]
  settings: ProjectTtsSettings | undefined
  projectId: string
  langCode: string
  /** The episode, for the entry names: `<file>_<lang>_<Character>.wav`.
   *  codex-editor's scheme, and it matters — a dubber ends up with tracks from
   *  several episodes in one folder. */
  fileBase?: string
  /** Fetch raw bytes for one clip. Production passes a closure over
   *  fetchCellAudio + the file's sync token. */
  fetchBytes: (args: { projectId: string; fileId: string; audioId: string; ext: string }) => Promise<Uint8Array>
  /** Decode bytes → mono PCM at TARGET_RATE. Production passes decodeToMono48k;
   *  tests pass a fake. */
  decode: (bytes: Uint8Array) => Promise<Float32Array>
  onProgress?: (done: number, total: number) => void
  resolveName?: ResolveCharacterName
}

export async function exportAudioByCharacter(
  args: ExportAudioArgs,
): Promise<{ blob: Blob; skipped: number; clips: number; characters: number; untimed: number }> {
  const groups = groupAudioByCharacter(args.cells, args.settings, args.resolveName)
  const zip = new JSZip()
  const usedNames = new Map<string, number>()
  const totalClips = groups.reduce((n, g) => n + g.clips.length, 0)
  let done = 0
  let skipped = 0
  let untimed = 0

  // A COMBINED generation is attached to every cell it covers under the same
  // base id — fetch and decode each unique clip ONCE, not once per cell (with
  // the WAV preference below that difference is a dozen multi-minute
  // downloads). A failure stays cached too, so retries per cell don't hammer.
  const pcmByClip = new Map<string, Promise<Float32Array | null>>()

  for (const group of groups) {
    const placed: { pcm: Float32Array; startSec: number; endSec: number | null }[] = []
    for (const clip of group.clips) {
      const cell = args.cells.find((c) => c.id === clip.cellId)!
      const parsed = parseFrontierAudioUrl(clip.url)
      if (!parsed) { done++; args.onProgress?.(done, totalClips); continue }
      const clipKey = `${parsed.audioId}.${parsed.ext}`
      let pcmPromise = pcmByClip.get(clipKey)
      if (!pcmPromise) {
        pcmPromise = (async () => {
          // Lossless preference (meeting 2026-08-05): client-synth generated
          // voices keep the original WAV as an unattached sibling (same base
          // id, ext "wav") — exports ALWAYS prefer it, regardless of the
          // device playback pref, so the zip isn't a lossy transcode. Any
          // failure falls back to the attached bytes.
          const generated = clip.audioId === cell.selectedGeneratedVoiceAudioId
          let bytes: Uint8Array | null = null
          if (generated && parsed.ext === "webm") {
            bytes = await args
              .fetchBytes({ projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: "wav" })
              .catch(() => null)
          }
          if (bytes == null || bytes.length === 0) {
            bytes = await args.fetchBytes({
              projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: parsed.ext,
            })
          }
          return bytes.length > 0 ? await args.decode(bytes) : null
        })()
        pcmByClip.set(clipKey, pcmPromise)
      }
      try {
        const pcm = await pcmPromise
        // An untimed line cannot be placed. Counted and reported — the old
        // export glued it on the end, which put words somewhere they were
        // never spoken.
        if (pcm && clip.startSec == null) untimed++
        else if (pcm) {
          // WHAT THE TIMELINE PLAYS, not everything that was recorded. The
          // decode cache is keyed on the audio id, so one decode serves every
          // cell sharing the clip and each takes its own window out of it —
          // which is also why the slice happens HERE rather than in the cache.
          //
          // `resolvePcmWindow` is the same arithmetic the transcribe path and
          // the preview engine use, including its rule that an inverted or
          // empty window falls back to the whole clip rather than to silence.
          const win = resolvePcmWindow(pcm.length, TARGET_RATE, {
            trimStartMs: clip.trimStartMs,
            trimEndMs: clip.trimEndMs,
          })
          const audible = win.isFull ? pcm : pcm.subarray(win.start, win.end)
          placed.push({ pcm: audible, startSec: clip.startSec!, endSec: clip.endSec })
        }
      } catch (err) {
        console.warn(`[audio-by-character] skipping clip ${clip.audioId} (${clip.cellId}):`, err)
        skipped++
      }
      done++
      args.onProgress?.(done, totalClips)
    }
    if (placed.length === 0) continue // no placeable, decodable audio
    // ONE CHARACTER AT A TIME, and released before the next. A forty-minute
    // track is ~115M samples; holding every character's at once is how this
    // falls over on a real episode. The Blob may be backed by disk, the
    // Int16Array cannot be.
    const durationSec = trackDurationSec(
      placed.map((c) => ({ startSec: c.startSec, lengthSec: c.pcm.length / TARGET_RATE, endSec: c.endSec })),
    )
    const track = placeClips(placed, durationSec, TARGET_RATE)
    if (track.length === 0) continue
    const wav = encodeWavPcm16Chunks([track], TARGET_RATE)
    // codex-editor's naming, plus its disambiguator for same-named cast.
    const stem = args.fileBase ? `${characterKey(args.fileBase)}_` : ""
    const base = `${stem}${args.langCode}_${characterFileKey(group.name)}`
    // Keyed case-blind (2026-08-27): "JESUS" and "Jesus" are two characters to
    // this sanitiser and one filename to macOS and Windows, so without the fold
    // the second silently replaced the first on extraction. The NAME keeps its
    // case — only the uniqueness check ignores it.
    const key = base.toLowerCase()
    const seen = usedNames.get(key) ?? 0
    usedNames.set(key, seen + 1)
    const name = seen === 0 ? `${base}.wav` : `${base}_${seen + 1}.wav`
    zip.file(name, wav)
  }

  // COUNTS OUT, so the caller can tell "nothing to export" from "everything
  // failed to decode". An empty JSZip still generates a perfectly valid 22-byte
  // archive, and handing that to someone as a download is the bug this whole
  // round started from — episode 302's export looked like it worked.
  const characters = Object.keys(zip.files).length
  // DEFLATE on PCM that is mostly silence is worth the seconds it costs: a
  // character with three lines in an hour compresses to almost nothing.
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" })
  return { blob, skipped, clips: totalClips, characters, untimed }
}
