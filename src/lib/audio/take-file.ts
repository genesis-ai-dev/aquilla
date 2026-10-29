// "Train a voice from this recording" (AQU-2291): the line's take becomes the
// first recording of a custom-voice training set. The take's bytes are fetched
// back from the cell-audio store and wrapped as a File, so the Train voice tab
// treats it exactly like a recording the person picked from disk.

import { audioMimeForExt } from "./mime"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

export interface FetchTakeAsFileArgs {
  projectId: string
  cell: CellData
  /** The take to copy: the line's recording or generated voice. */
  audioId: string
  session: FrontierSession | null
}

/** The take's audio as a File named after the take (or the line). Throws when
 *  the take has no stored audio to copy. */
export async function fetchTakeAsFile(args: FetchTakeAsFileArgs): Promise<File> {
  const { projectId, cell, audioId, session } = args
  const att = cell.attachments?.[audioId]
  const parsed = att?.url ? parseFrontierAudioUrl(att.url) : null
  if (!parsed) throw new Error("This take's audio isn't available to copy.")
  const bytes = await fetchCellAudio({
    projectId,
    fileId: cell.fileId,
    audioId: parsed.audioId,
    ext: parsed.ext,
    getSyncToken: audioSyncTokenFetcherForSession(session),
  })
  const base = (att?.label?.trim() || cell.cellLabel?.trim() || cell.id).replace(/[\\/:*?"<>|]+/g, "-")
  return new File([bytes as BlobPart], `${base}.${parsed.ext}`, { type: audioMimeForExt(parsed.ext) })
}
