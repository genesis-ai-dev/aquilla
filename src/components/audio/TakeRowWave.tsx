// A take's shape at list size — the chip's rectangle in its track's colour,
// 20px tall, beside each take in the Recording tab's list (Sam, 2026-09-29).
//
// Peaks only, no player: a list of takes must not open an audio element per
// row. `loadPeaksFor` caches by clip, so a take already drawn anywhere in the
// app is instant here. On a project whose media waits to be asked for, the
// rectangle is drawn without an outline rather than fetching on sight.

import { useEffect, useMemo, useState } from "react"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"
import { WAVEFORM_BINS, autoLoadsPeaks, loadPeaksFor } from "@/lib/audio/peaks-loader"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { WaveformRect } from "./WaveformRect"

export function TakeRowWave({
  projectId,
  fileId,
  att,
  session,
  strategy,
  generated,
  trackVars,
}: {
  projectId: string
  /** The file that OWNS the take. */
  fileId: string
  att: Pick<AudioAttachmentOut, "audioId" | "url" | "durationMs" | "trimStartMs" | "trimEndMs">
  session: FrontierSession | null
  strategy: string | null | undefined
  generated: boolean
  trackVars?: Record<string, string>
}) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  // Which take's read has come back (with a shape or without one): until then
  // the rectangle pulses a placeholder instead of standing flat.
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const load = autoLoadsPeaks(strategy)
  const getSyncToken = useMemo(() => audioSyncTokenFetcherForSession(session), [session])
  useEffect(() => {
    if (!load) return
    let live = true
    void loadPeaksFor({
      attachmentKey: att.audioId,
      url: att.url,
      projectId,
      fileId,
      bins: WAVEFORM_BINS,
      getSyncToken,
    }).then((p) => {
      if (!live) return
      setPeaks(p)
      setSettledFor(att.audioId)
    })
    return () => { live = false }
  }, [load, att.audioId, att.url, projectId, fileId, getSyncToken])
  // The trimmed-off ends, faded, as on every other waveform off the timeline.
  const dur = att.durationMs ?? 0
  const keep = dur > 0 && (att.trimStartMs != null || att.trimEndMs != null)
    ? { start: (att.trimStartMs ?? 0) / dur, end: (att.trimEndMs ?? dur) / dur }
    : null
  return (
    <WaveformRect
      peaks={peaks}
      height={20}
      kind={generated ? "generated" : "take"}
      trackVars={trackVars}
      keep={keep}
      loading={load && settledFor !== att.audioId}
      className="w-14 shrink-0"
      testId={`take-row-wave-${att.audioId}`}
    />
  )
}
