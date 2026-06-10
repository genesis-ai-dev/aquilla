// Attach media to an EXISTING time-ordered file (media-lens empty state).
//
// The Import dialog can't do this — `emitMediaFile` always creates a NEW
// time-ordered file — so a subtitle file (VTT/SRT) had no way to get its
// clip into the media layer. Two paths:
//   • upload a local audio/video file: bytes go to R2 once, silence-split
//     segments attach the shared clip with trim windows (same shape as the
//     importer and diarization);
//   • link a media URL: the clip stays at its source and playback streams it —
//     only timing/metadata is captured, nothing is copied into project storage.

import { v7 as uuidv7 } from "uuid"
import { computeMediaSegmentSpecs } from "@/lib/import"
import { buildAudioId, deleteCellAudio, uploadCellAudio } from "@/lib/audio/upload"
import { emitCellAudioAttach, emitSourceCellCreate } from "@/lib/sync/events-emit"

export interface AttachMediaContext {
  projectId: string
  /** The existing time-ordered file receiving the media segments. */
  fileId: string
  author: string
  /** Mints a sync-token scoped to (projectId, fileId). */
  getToken: (fileId: string) => Promise<string | null>
}

/**
 * Upload a local clip's bytes and append its media segments to the file.
 * Caller flushes the outbox and revalidates cells afterwards (diarize pattern).
 */
export async function attachMediaFileToTimeline(
  file: File,
  ctx: AttachMediaContext,
): Promise<{ segments: number }> {
  const { durationMs, specs } = await computeMediaSegmentSpecs(file)

  const ext = (file.name.split(".").pop() || "bin").toLowerCase()
  const audioId = buildAudioId(ctx.fileId)
  const upload = await uploadCellAudio({
    projectId: ctx.projectId,
    fileId: ctx.fileId,
    audioId,
    ext,
    blob: file,
    getSyncToken: (_p, f) => ctx.getToken(f),
  })

  try {
    let prevCellId: string | null = null
    for (const [i, s] of specs.entries()) {
      await emitSourceCellCreate({
        projectId: ctx.projectId,
        fileId: ctx.fileId,
        cellId: s.cellId,
        anchorCellId: prevCellId,
        value: file.name,
        medium: "media",
        sequenceIndex: i,
        ...(s.startMs !== undefined && s.endMs !== undefined ? { startMs: s.startMs, endMs: s.endMs } : {}),
        author: ctx.author,
      })
      await emitCellAudioAttach({
        projectId: ctx.projectId,
        fileId: ctx.fileId,
        cellId: s.cellId,
        audioId: upload.audioId,
        url: upload.url,
        slot: "recording",
        ...(file.type ? { mimeType: file.type } : {}),
        ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
        ...(s.trimStartMs !== undefined && s.trimEndMs !== undefined
          ? { trimStartMs: s.trimStartMs, trimEndMs: s.trimEndMs }
          : {}),
        author: ctx.author,
      })
      prevCellId = s.cellId
    }
  } catch (err) {
    // The bytes landed but an event failed → clean up the orphan blob.
    await deleteCellAudio({
      projectId: ctx.projectId,
      fileId: ctx.fileId,
      audioId,
      ext,
      getSyncToken: (_p, f) => ctx.getToken(f),
    })
    throw err
  }

  return { segments: specs.length }
}

/**
 * Attach a remote clip by URL as one whole-clip media segment. Duration is
 * probed up front (timing is required on timeline media segments); the URL is
 * stored as the attachment source and playback streams from it.
 */
export async function attachMediaUrlToTimeline(
  url: string,
  ctx: AttachMediaContext,
): Promise<{ durationMs: number }> {
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("That doesn't look like a valid URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) media URLs can be attached.")
  }

  const durationMs = await probeRemoteMediaDurationMs(trimmed)

  const cellId = uuidv7()
  await emitSourceCellCreate({
    projectId: ctx.projectId,
    fileId: ctx.fileId,
    cellId,
    anchorCellId: null,
    value: mediaNameFromUrl(trimmed),
    medium: "media",
    sequenceIndex: 0,
    startMs: 0,
    endMs: Math.round(durationMs),
    author: ctx.author,
  })
  await emitCellAudioAttach({
    projectId: ctx.projectId,
    fileId: ctx.fileId,
    cellId,
    audioId: buildAudioId(ctx.fileId),
    url: trimmed,
    slot: "recording",
    durationMs: Math.round(durationMs),
    author: ctx.author,
  })

  return { durationMs }
}

/** Display name for a URL-attached clip: the path's basename, else the host. */
export function mediaNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const base = u.pathname.split("/").filter(Boolean).pop()
    return base ? decodeURIComponent(base) : u.hostname
  } catch {
    return url
  }
}

const PROBE_TIMEOUT_MS = 30_000

/**
 * Probe a remote clip's duration by streaming just its metadata through a
 * detached media element (no CORS needed for playback/metadata). Rejects when
 * metadata can't load or the source has no finite duration (live stream) —
 * page URLs (YouTube etc.) fail here too; only direct media links work.
 */
export function probeRemoteMediaDurationMs(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("video")
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      el.removeAttribute("src")
      fn()
    }
    const timer = setTimeout(
      () => settle(() => reject(new Error("Timed out loading media metadata from that URL."))),
      PROBE_TIMEOUT_MS,
    )
    el.preload = "metadata"
    el.onloadedmetadata = () => {
      const sec = el.duration
      if (Number.isFinite(sec) && sec > 0) settle(() => resolve(sec * 1000))
      else settle(() => reject(new Error("That media source has no fixed duration (is it a live stream?).")))
    }
    el.onerror = () =>
      settle(() =>
        reject(new Error("Couldn't load media from that URL — check it's a direct link to an audio/video file.")),
      )
    el.src = url
  })
}
