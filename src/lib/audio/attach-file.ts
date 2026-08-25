// Attach an existing audio FILE to a cell as a take — the picker path, shared
// by the cell action rail's upload button (AQU-513) and the recording modal's
// "upload a file" control (AQU-646 stage 5).
//
// Extracted from CellAudioUploadButton so the two call sites cannot drift: the
// R2 PUT → cell.audio.attach → orphan-cleanup → optimistic-inject dance below
// has to stay byte-for-byte in step with AudioRecordingModal.save(), and it had
// already fallen four gaps behind when it lived inside a button component.
//
// A plain async function, deliberately NOT a hook: it touches no React state,
// each caller already owns its own uploading/error state (the rail has an
// anchored popover, the modal has a phase machine), and a plain function is
// callable from a phase machine and testable without a renderer.

import type { FrontierSession } from "@/lib/frontier/types"
import { buildAudioId, deleteCellAudio, uploadCellAudio } from "@/lib/audio/upload"
import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { RECORDING_SLOT } from "@/lib/timeline/track-slots"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { injectOptimisticAudioAttachment, notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { markProjectHasAudioDataSoon } from "@/lib/audio/project-audio-state"
import { probeDurationMsSafe } from "@/lib/import"

/** `accept` for the hidden `<input type="file">`. `audio/*` alone is not
 *  enough: some mobile browsers report an empty or wrong MIME type for files
 *  off the camera roll / Files app, so the extensions are listed too. */
export const ACCEPT = "audio/*,.wav,.mp3,.m4a,.ogg"

/** Decision 2026-08-05: audio work is blocked UP FRONT while offline instead
 *  of failing mid-flow with a raw fetch error. One copy of the message, used
 *  by every gate — the recording modal imports this rather than keeping the
 *  local duplicate it used to have. */
export const OFFLINE_MESSAGE =
  "You're offline — recordings can't be saved without a connection. Reconnect and try again."

// Extensions `audioMimeForExt` (./mime.ts) can map to a real audio MIME type.
// Kept as an explicit list rather than probing that function, because its
// default arm returns "audio/mpeg" for anything unknown — asking it "do you
// know this?" is not a question it can answer. Keep the two in sync.
const KNOWN_AUDIO_EXTS = new Set([
  "wav", "mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "webm", "flac",
])

// 100 MB. Nothing in this path has a progress UI — no bar, no byte counter —
// so an oversized pick is an unexplained multi-minute freeze covering both the
// OPFS warm (the whole file through memory) and the R2 PUT. `uploadCellAudio`
// has its own, slightly lower, hard R2 object cap; this gate is not a duplicate
// of it — it fires BEFORE the cache write and names the file's own size. Files
// landing in the few MB between the two are refused by the upload layer's
// message instead, which is the right one for them (it talks about storage).
const MAX_ATTACH_BYTES = 100 * 1024 * 1024

const mb = (n: number) => Math.round(n / (1024 * 1024))

/** Extension for the R2 object name. Prefer the filename's own extension
 *  (wav/mp3/m4a survive that way); fall back to a mimeType guess, then a
 *  generic default so an upload never fails just because the ext is unclear. */
export function extFromFile(file: File): string {
  const dot = file.name.lastIndexOf(".")
  if (dot > 0 && dot < file.name.length - 1) {
    const fromName = file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "")
    if (fromName) return fromName
  }
  const mime = file.type.toLowerCase()
  if (mime.includes("wav")) return "wav"
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3"
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a"
  if (mime.includes("ogg")) return "ogg"
  return "bin"
}

/**
 * Refuse a pick that cannot become a usable take. Returns null when the file
 * is acceptable, otherwise the message to show the user.
 *
 * There was no validation at all before this: a renamed `.txt` uploaded
 * happily and then sat on the cell as a clip that would never play. Honest
 * limit — a renamed `.txt` STILL passes, because this checks the declared type
 * and the extension, not the bytes. A real content sniff is out of scope, and
 * the tempting shortcut of gating on `probeDurationMsSafe` returning undefined
 * would wrongly reject perfectly good files the browser simply can't probe
 * (that helper degrades to undefined by design, including for every
 * MediaRecorder webm).
 */
export function validateAudioFile(file: File): string | null {
  const declaredAudio = file.type.toLowerCase().startsWith("audio/")
  if (!declaredAudio && !KNOWN_AUDIO_EXTS.has(extFromFile(file))) {
    return "That doesn't look like an audio file — pick a .wav, .mp3, .m4a or .ogg."
  }
  if (file.size > MAX_ATTACH_BYTES) {
    return `That file is ${mb(file.size)} MB — the limit is ${mb(MAX_ATTACH_BYTES)} MB. ` +
      "Pick a clip of just this line, or trim it first."
  }
  return null
}

export interface AttachAudioFileArgs {
  /**
   * AQU-646 stage 3: which TRACK the file lands on, as a storage slot.
   * Defaults to the dub row's, so the cell action rail is unchanged; the
   * recorder passes its own target track's.
   */
  slot?: string
  session: FrontierSession | null
  projectId: string
  fileId: string
  cellId: string
  file: File
  /** Author attribution for the cell.audio.attach event. */
  username: string
  /** AQU-646 round 8: the take's PERMANENT display name ("Take 3"). The modal
   *  passes `nextTakeLabel(recordingTakes)` because its takes strip is ~100px
   *  below and an unlabelled "Take" beside "Take 1"/"Take 2" reads as a defect.
   *  The rail button passes nothing, deliberately: it has no takes list, and
   *  fetching one to label a single icon click isn't worth the request. */
  label?: string
}

export interface AttachAudioFileResult {
  /** Stored id INCLUDING the extension ("audio-cell12-….wav") — the form the
   *  attachment and every lookup key use, not the bare id `uploadCellAudio`
   *  echoes back. */
  audioId: string
  url: string
  durationMs: number | undefined
}

/**
 * Upload `file` to R2 and attach it to `cellId` as a take in the "recording"
 * slot. Throws with a user-presentable message on every failure; the caller
 * owns the busy/error UI and fires its own `onTakeSaved`.
 *
 * NOT auto-transcribed, and that asymmetry with the mic recorder is deliberate
 * — do not "fix" it. A recorded take's blob is provably this line, so Whisper
 * on it is money well spent. An uploaded file routinely is NOT this line: the
 * wrong file gets picked, or someone attaches a 40-minute source clip. Whisper
 * on that is slow, costly, and lands karaoke timings for the wrong content on
 * the cell.
 */
export async function attachAudioFileToCell(args: AttachAudioFileArgs): Promise<AttachAudioFileResult> {
  const { session, projectId, fileId, cellId, file, username, label, slot = RECORDING_SLOT } = args

  // Hard front gate, not a retry: audio bytes can NEVER be queued offline —
  // the outbox carries JSON events only and the bytes go straight to R2 by
  // fetch — so offline is three doomed retries ending in a raw
  // "TypeError: Failed to fetch". One clear sentence instead.
  if (!navigator.onLine) throw new Error(OFFLINE_MESSAGE)
  if (!session?.jwt) throw new Error("Sign in to upload recordings")

  const invalid = validateAudioFile(file)
  if (invalid) throw new Error(invalid)

  const ext = extFromFile(file)
  const audioId = buildAudioId(cellId)
  const getSyncToken = audioSyncTokenFetcherForSession(session)

  // Warm the OPFS byte cache BEFORE the upload (FRO-355), keyed exactly as
  // useCellAudio looks bytes up (audioId+ext of the frontier-audio:// URL), so
  // the clip plays from local bytes with no network and no JWT the moment the
  // attach lands. Mirrors save(): warming first means a FAILED upload leaves an
  // unreachable cache entry that simply ages out of the LRU, where warming
  // after a partial failure could leave a reachable entry pointing at nothing.
  await audioCachePutBlob(audioId, ext, file)

  const result = await uploadCellAudio({ projectId, fileId, audioId, ext, blob: file, getSyncToken })
  markProjectHasAudioDataSoon(projectId)
  const fullAudioId = `${result.audioId}.${result.ext}`

  // Round 6: carry the upload's duration so its Target-track chip renders at
  // the recording's real length. Best-effort — unlike a mic take, nothing here
  // timed the clip, so a probe is the only source there is.
  const durationMs = await probeDurationMsSafe(file)

  let attachEventId: string
  try {
    attachEventId = await emitCellAudioAttach({
      projectId,
      fileId,
      cellId,
      audioId: fullAudioId,
      url: result.url,
      slot,
      mimeType: file.type || undefined,
      durationMs,
      label,
      author: username,
    })
  } catch (emitErr) {
    // F8: the R2 object uploaded fine but the attach event failed — delete it
    // rather than leaking storage, then re-throw so the user sees the real
    // error. The cleanup itself is non-fatal.
    void deleteCellAudio({ projectId, fileId, audioId: result.audioId, ext: result.ext, getSyncToken })
    throw emitErr
  }

  // Flip `hasAudio` immediately — the bus poke below refetches the server
  // projection, but that races the outbox flush and would otherwise leave the
  // gutter icon stale until a manual reload.
  injectOptimisticAudioAttachment(fileId, cellId, {
    audioId: fullAudioId,
    url: result.url,
    slot: "recording",
    mimeType: file.type || null,
    voiceId: null,
    referenceAudioId: null,
    durationMs: durationMs ?? null,
    label,
    trimStartMs: null,
    trimEndMs: null,
  }, attachEventId)
  notifyAudioAttachmentsChanged(fileId)

  return { audioId: fullAudioId, url: result.url, durationMs }
}
