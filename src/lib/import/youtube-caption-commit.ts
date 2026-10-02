import { emitParsedFile, type EmitParsedFileResult, type ImportContext } from "../import"
import { publishStagedImport } from "../sync/bulk-import"
import type { PreparedYouTubeCaptionImport, PreparedYouTubePictureImport } from "./youtube-captions"
import { v7 as uuidv7 } from "uuid"

/** One preview owns one staged file. Publication retries keep that identity. */
export function createYouTubeCaptionCommit(
  prepared: PreparedYouTubeCaptionImport | PreparedYouTubePictureImport,
  ctx: ImportContext,
): () => Promise<EmitParsedFileResult> {
  const publishEventId = uuidv7()
  const videoEventId = uuidv7()
  let staged: EmitParsedFileResult | null = null
  let inFlight: Promise<EmitParsedFileResult> | null = null
  let published = false
  return () => {
    if (published) return Promise.resolve(staged!)
    if (inFlight) return inFlight
    inFlight = (async () => {
      ctx.signal?.throwIfAborted()
      if (!staged) {
        staged = await emitParsedFile(prepared, prepared.rawSourceFormat ?? "video", {
          ...ctx, deferPublication: true, reimportFileIds: undefined,
        })
      }
      ctx.signal?.throwIfAborted()
      await publishStagedImport({
        projectId: ctx.projectId, fileId: staged.ref.id,
        coreMediaUrl: prepared.videoUrl, getToken: ctx.getToken,
        publishEventId, videoEventId,
        signal: ctx.signal,
      })
      staged = { ...staged, ref: { ...staged.ref, coreMediaUrl: prepared.videoUrl } }
      published = true
      return staged
    })().finally(() => { inFlight = null })
    return inFlight
  }
}
