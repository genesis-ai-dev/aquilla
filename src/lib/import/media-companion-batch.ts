import { detectFileType, isMediaFileType, isSubtitleImportFile } from "../parsers/types"
import type { MediaTextSource, MediaTextSourceOption } from "./media-cues"

interface ReviewedMediaBatch {
  files: File[]
  sources: Map<File, MediaTextSource>
}

/** Review before writes. Used sidecars become media segment text; unselected
 * sidecars retain the ordinary standalone subtitle import path.
 */
export async function reviewMediaCompanions(
  files: readonly File[],
  prepare: (file: File) => Promise<MediaTextSource>,
  review: (media: File, options: MediaTextSourceOption[]) => Promise<MediaTextSource | undefined | null>,
  embedded?: (media: File) => Promise<MediaTextSourceOption[]>,
): Promise<ReviewedMediaBatch | null> {
  const media = files.filter(file => {
    const type = detectFileType(file.name)
    return type !== null && isMediaFileType(type)
  })
  const subtitles = files.filter(file => isSubtitleImportFile({ type: detectFileType(file.name) ?? undefined }))
  const sources = new Map<File, MediaTextSource>()
  if (media.length === 0 || (subtitles.length === 0 && !embedded)) return { files: [...files], sources }
  const candidates = await Promise.all(subtitles.map(async (file, i) => ({
    file, id: `sidecar-${i}`, label: file.name, source: await prepare(file),
  })))
  const consumed = new Set<File>()
  const stem = (name: string) => name.replace(/\.[^.]+$/, "").normalize("NFC").toLowerCase()
  for (const file of media) {
    const sidecars = [...candidates].sort((a, b) =>
      Number(stem(b.file.name) === stem(file.name)) - Number(stem(a.file.name) === stem(file.name)),
    )
    const options: MediaTextSourceOption[] = [...sidecars, ...(await embedded?.(file) ?? [])]
    if (options.length === 0) continue
    const selected = await review(file, options)
    if (selected === null) return null
    if (selected) {
      sources.set(file, selected)
      // The preview changes cues while retaining the exact original artifact.
      const sidecar = selected.artifact && candidates.find(option => option.source.artifact === selected.artifact)
      if (sidecar) consumed.add(sidecar.file)
    }
  }
  return { files: files.filter(file => !consumed.has(file)), sources }
}
