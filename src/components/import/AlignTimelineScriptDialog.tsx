import { useEffect, useRef } from "react"
import type { CellData } from "@/hooks/useCells"
import { alignSourceScript } from "@/lib/audio/align-source-script"
import { audioCacheGet } from "@/lib/audio/bytes-cache"
import { playClip, type ClipPreviewHandle } from "@/lib/audio/clip-preview"
import { fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { createTimelineTextTrackImporter } from "@/lib/import/timeline-text"
import { ScriptAlignmentDialog, type AlignmentTrackDestination,
  type ScriptAlignmentConfirmation } from "./ScriptAlignmentDialog"

interface Props {
  projectId: string
  fileId: string
  mediaName: string
  clipUrl: string
  language?: string
  durationMs?: number
  canEditTracks: boolean
  tracks: readonly AlignmentTrackDestination[]
  cells: readonly CellData[]
  getToken(fileId: string): Promise<string | null>
  onSaved(): Promise<void>
  onCancel(): void
}

/** Publish reviewed paragraphs separately from the source audio and wording. */
export function AlignTimelineScriptDialog(props: Props) {
  const preview = useRef<ClipPreviewHandle | null>(null)
  const operation = useRef<{
    key: string
    commit: ReturnType<typeof createTimelineTextTrackImporter>
    published: boolean
  } | null>(null)
  useEffect(() => () => preview.current?.stop(), [])

  async function align(script: string, signal: AbortSignal) {
    return alignSourceScript({
      script, signal, cells: props.cells, clipUrl: props.clipUrl,
      language: props.language,
      async loadAudio() {
        signal.throwIfAborted()
        const clip = parseFrontierAudioUrl(props.clipUrl)
        if (!clip) throw new Error("Choose an uploaded source audio clip.")
        const cached = await audioCacheGet(clip.audioId, clip.ext)
        signal.throwIfAborted()
        if (cached) return cached
        const bytes = await fetchCellAudio({
          projectId: props.projectId, fileId: props.fileId, ...clip,
          getSyncToken: (_projectId, fileId) => props.getToken(fileId),
        })
        signal.throwIfAborted()
        return bytes
      },
    })
  }

  async function confirm(input: ScriptAlignmentConfirmation) {
    if (!props.canEditTracks) throw new Error("Enable track editing to align a script.")
    input.signal.throwIfAborted()
    const key = JSON.stringify({ script: input.script, cues: input.cues,
      name: input.name, trackId: input.trackId, overwrite: input.overwrite,
      artifact: input.scriptArtifact ? { name: input.scriptArtifact.name,
        bytes: Array.from(new Uint8Array(input.scriptArtifact.bytes)) } : undefined })
    if (!operation.current || operation.current.key !== key) {
      operation.current = {
        key, published: false,
        commit: createTimelineTextTrackImporter({
          projectId: props.projectId, anchorFileId: props.fileId,
          name: input.name ?? "Aligned script", durationMs: props.durationMs,
          trackId: input.trackId, overwrite: input.overwrite,
          source: { cues: input.cues, artifact: {
            name: input.scriptArtifact?.name ?? "Aligned script.txt", format: "txt",
            bytes: input.scriptArtifact?.bytes ?? new TextEncoder().encode(input.script).buffer,
          } },
          getToken: props.getToken, signal: input.signal,
        }),
      }
    }
    if (!operation.current.published) {
      await operation.current.commit()
      operation.current.published = true
    }
    input.signal.throwIfAborted()
    await props.onSaved()
    props.onCancel()
  }

  return <ScriptAlignmentDialog
    mediaName={props.mediaName} durationMs={props.durationMs}
    tracks={props.tracks} align={align} onConfirm={confirm}
    onCancel={props.onCancel}
    onPreviewRange={(start, end) => {
      preview.current?.stop()
      preview.current = playClip({
        url: props.clipUrl, projectId: props.projectId, fileId: props.fileId,
        durationSec: props.durationMs === undefined ? null : props.durationMs / 1000,
        getSyncToken: (_projectId, fileId) => props.getToken(fileId),
      }, { startSec: start, endSec: end })
    }}
  />
}
