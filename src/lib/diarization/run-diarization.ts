// Client orchestration for the "Diarize" action (M3).
//
// Flow: find the media file's clip → POST /start → poll /status → on success,
// REPLACE the file's media segments with one per speaker turn (delete existing
// media cells, create N timed `medium:'media'` cells each attaching the shared
// clip with its trim window) and create/assign a "Speaker N" cast member per
// speaker. Server side: sync-worker/src/diarization.ts + Modal pyannote 3.1.
//
// The worker is the only thing that talks to Modal; the browser just calls our
// own endpoints with its per-file sync token.

import { v7 as uuidv7 } from "uuid"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { emitSourceCellCreate, emitSourceCellDelete, emitCellAudioAttach } from "@/lib/sync/events-emit"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import { buildCastAdditions } from "@/lib/import/cast-from-speakers"
import { turnsToSegments, speakerLabel, type DiarizationTurn } from "@/lib/timeline/diarization"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

export type DiarizationPhase = "starting" | "running" | "applying" | "done" | "failed"

export interface RunDiarizationArgs {
  projectId: string
  fileId: string
  author: string
  /** Current cells of the file — used to locate the clip + existing media cells. */
  cells: CellData[]
  getToken: (fileId: string) => Promise<string | null>
  ttsSettings: ProjectTtsSettings | undefined
  saveTts: (overrides: Partial<ProjectTtsSettings>) => Promise<void> | void
  /** Optional caller hint; -1/0/undefined ⇒ auto-detect. */
  numSpeakers?: number
  onPhase?: (phase: DiarizationPhase, detail?: string) => void
  signal?: AbortSignal
}

export interface RunDiarizationResult {
  speakers: number
  segments: number
}

interface Clip {
  /** R2 object name (last path segment), e.g. "audio-xyz.webm". */
  objectName: string
  /** audioId (no extension) + url, for re-attaching the shared clip per cell. */
  audioId: string
  url: string
}

const POLL_INTERVAL_MS = 2500
const POLL_TIMEOUT_MS = 20 * 60 * 1000 // 20 min ceiling for a long episode

/** Locate the media file's source clip from its media cells' attachments. */
export function findFileClip(cells: readonly CellData[]): Clip | null {
  for (const c of cells) {
    if (c.medium !== "media") continue
    const att = c.attachments
    if (!att) continue
    const url = (c.selectedAudioId && att[c.selectedAudioId]?.url) || Object.values(att)[0]?.url
    const parsed = url ? parseFrontierAudioUrl(url) : null
    if (parsed) {
      return { objectName: `${parsed.audioId}.${parsed.ext}`, audioId: parsed.audioId, url }
    }
  }
  return null
}

const origin = () => syncWorkerHttpOrigin()

async function startJob(args: RunDiarizationArgs, audioObject: string): Promise<string> {
  const token = await args.getToken(args.fileId)
  const res = await fetch(`${origin()}/api/v1/diarization/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: args.projectId,
      fileId: args.fileId,
      audioObject,
      ...(args.numSpeakers && args.numSpeakers > 0 ? { numSpeakers: args.numSpeakers } : {}),
    }),
    signal: args.signal,
  })
  if (!res.ok) {
    throw new Error(`diarization start failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`)
  }
  const body = (await res.json()) as { jobId?: string }
  if (!body.jobId) throw new Error("diarization start returned no jobId")
  return body.jobId
}

async function pollJob(args: RunDiarizationArgs, jobId: string): Promise<DiarizationTurn[]> {
  const token = await args.getToken(args.fileId)
  const started = Date.now()
  for (;;) {
    if (args.signal?.aborted) throw new Error("diarization cancelled")
    if (Date.now() - started > POLL_TIMEOUT_MS) throw new Error("diarization timed out")
    const res = await fetch(`${origin()}/api/v1/diarization/status?jobId=${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: args.signal,
    })
    if (!res.ok) throw new Error(`diarization status failed (${res.status})`)
    const body = (await res.json()) as { status: string; turns?: DiarizationTurn[]; error?: string }
    if (body.status === "succeeded") return body.turns ?? []
    if (body.status === "failed") throw new Error(body.error ?? "diarization failed")
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

async function applyTurns(
  args: RunDiarizationArgs,
  clip: Clip,
  turns: DiarizationTurn[],
): Promise<RunDiarizationResult> {
  const { segments, speakers } = turnsToSegments(turns)

  // Replace: drop the file's current media cells, then create one per turn.
  for (const c of args.cells) {
    if (c.medium === "media") {
      await emitSourceCellDelete({ projectId: args.projectId, fileId: args.fileId, cellId: c.id, author: args.author })
    }
  }

  const pairs: { cellId: string; speaker: string }[] = []
  let prevCellId: string | null = null
  let seq = 0
  for (const s of segments) {
    const cellId = uuidv7()
    await emitSourceCellCreate({
      projectId: args.projectId,
      fileId: args.fileId,
      cellId,
      anchorCellId: prevCellId,
      value: "",
      medium: "media",
      sequenceIndex: seq,
      startMs: s.startMs,
      endMs: s.endMs,
      author: args.author,
    })
    await emitCellAudioAttach({
      projectId: args.projectId,
      fileId: args.fileId,
      cellId,
      audioId: clip.audioId,
      url: clip.url,
      slot: "recording",
      trimStartMs: s.trimStartMs,
      trimEndMs: s.trimEndMs,
      author: args.author,
    })
    pairs.push({ cellId, speaker: speakerLabel(s.speaker) })
    prevCellId = cellId
    seq += 1
  }

  // Cast: one "Speaker N" voice per cluster, assigned to its cells. Merge the
  // new assignments into any existing ones (don't clobber other files).
  const additions = buildCastAdditions(pairs, args.ttsSettings, () => uuidv7())
  await args.saveTts({
    voices: additions.voices,
    castAssignments: { ...(args.ttsSettings?.castAssignments ?? {}), ...additions.castAssignments },
  })

  return { speakers: speakers.length, segments: segments.length }
}

/**
 * Run the full diarization flow for a media file. Throws on failure (caller
 * surfaces it). On success the caller should revalidate cells.
 */
export async function runDiarization(args: RunDiarizationArgs): Promise<RunDiarizationResult> {
  const clip = findFileClip(args.cells)
  if (!clip) throw new Error("no media clip found on this file to diarize")

  args.onPhase?.("starting")
  const jobId = await startJob(args, clip.objectName)

  args.onPhase?.("running")
  const turns = await pollJob(args, jobId)
  if (turns.length === 0) throw new Error("diarization found no speech")

  args.onPhase?.("applying")
  const result = await applyTurns(args, clip, turns)

  args.onPhase?.("done")
  return result
}
