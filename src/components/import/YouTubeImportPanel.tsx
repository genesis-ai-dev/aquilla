import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n/I18nProvider"
import { createMediaFileCommit, probeMediaDurationMs,
  type EmitParsedFileResult, type ImportContext } from "@/lib/import"
import { MAX_AUDIO_UPLOAD_BYTES } from "@/lib/audio/upload"
import { prepareEmbeddedSubtitleSources } from "@/lib/import/embedded-subtitle-sources"
import { type MediaTextSourceOption } from "@/lib/import/media-cues"
import { MediaImportPreviewDialog } from "./MediaImportPreviewDialog"
import { decodeImportText } from "@/lib/import/ai-recipe"
import { createYouTubeCaptionCommit } from "@/lib/import/youtube-caption-commit"
import { prepareYouTubeCaptionImport,
  prepareYouTubePictureImport,
  type PreparedYouTubeCaptionImport, type PreparedYouTubePictureImport } from "@/lib/import/youtube-captions"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { detectFileType, isMediaFileType, type FileReference } from "@/lib/parsers/types"

export function YouTubeImportPanel({ ctx, onImported }: {
  ctx: ImportContext
  onImported: (refs: FileReference[]) => void | Promise<void>
}) {
  const t = useT()
  const id = useId()
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [source, setSource] = useState<"picture" | "captions" | "media">("picture")
  const [file, setFile] = useState<File | null>(null)
  const [media, setMedia] = useState<File | null>(null)
  const [mediaReview, setMediaReview] = useState<{
    file: File
    fileType: "audio" | "video"
    videoUrl: string
    sources: MediaTextSourceOption[]
    durationMs?: number
  } | null>(null)
  const [preview, setPreview] = useState<PreparedYouTubeCaptionImport | PreparedYouTubePictureImport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const commit = useRef<(() => Promise<EmitParsedFileResult>) | null>(null)
  const controller = useRef(new AbortController())
  useEffect(() => {
    const active = new AbortController()
    controller.current = active
    return () => active.abort()
  }, [])

  const reset = () => {
    setPreview(null)
    setError(null)
    commit.current = null
  }
  const read = async () => {
    if (busy || (source === "captions" && !file)) return
    const active = controller.current
    setBusy(true)
    reset()
    try {
      if (source === "media") {
        if (!media) throw new Error("Choose your original audio or video.")
        const fileType = detectFileType(media.name)
        if (!fileType || !isMediaFileType(fileType)) {
          throw new Error("Choose a supported audio or video file.")
        }
        if (media.size === 0 || media.size > MAX_AUDIO_UPLOAD_BYTES) {
          throw new Error("Choose a non-empty audio or video within the upload limit.")
        }
        const prepared = prepareYouTubePictureImport({ url, name: media.name })
        const sources = /\.(mp4|m4a)$/i.test(media.name)
          ? prepareEmbeddedSubtitleSources(await media.arrayBuffer()).map((option, index) => ({
            ...option, label: t(option.language
              ? "importExport.mediaPreview.embeddedLanguage" : "importExport.mediaPreview.embedded", {
              number: index + 1, language: option.language ?? "",
            }),
          })) : []
        const durationMs = await probeMediaDurationMs(media).catch(() => undefined)
        active.signal.throwIfAborted()
        setMediaReview({ file: media, fileType: fileType as "audio" | "video",
          videoUrl: prepared.videoUrl, sources, durationMs })
        return
      }
      let prepared: PreparedYouTubeCaptionImport | PreparedYouTubePictureImport
      if (source === "captions" && file) {
        assertSourceUploadByteLength(file.size)
        const bytes = await file.arrayBuffer()
        active.signal.throwIfAborted()
        prepared = prepareYouTubeCaptionImport({
          url, captionName: file.name,
          captionText: decodeImportText(bytes, file.name), rawBytes: bytes,
        })
      } else {
        prepared = prepareYouTubePictureImport({ url, name })
      }
      active.signal.throwIfAborted()
      commit.current = createYouTubeCaptionCommit(prepared, {
        ...ctx, signal: ctx.signal
          ? AbortSignal.any([ctx.signal, active.signal]) : active.signal,
      })
      setPreview(prepared)
    } catch (cause) {
      if (!active.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (!active.signal.aborted) setBusy(false)
    }
  }
  const publish = async () => {
    if (!commit.current || busy) return
    const active = controller.current
    setBusy(true)
    setError(null)
    try {
      const result = await commit.current()
      active.signal.throwIfAborted()
      await onImported([result.ref])
    } catch (cause) {
      if (!active.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (!active.signal.aborted) setBusy(false)
    }
  }
  return (
    <>
    {mediaReview && <MediaImportPreviewDialog
      mediaName={mediaReview.file.name} sources={mediaReview.sources}
      durationMs={mediaReview.durationMs} busy={busy}
      confirmLabel={t("importExport.youtube.importMedia")}
      onCancel={() => setMediaReview(null)} onConfirm={mediaTextSource => {
        const active = controller.current
        const mediaCommit = createMediaFileCommit(mediaReview.file, mediaReview.fileType, {
          ...ctx, mediaPictureUrl: mediaReview.videoUrl, mediaTextSource,
          signal: ctx.signal ? AbortSignal.any([ctx.signal, active.signal]) : active.signal,
        })
        commit.current = async () => ({ ref: await mediaCommit(), speakerPairs: [] })
        setPreview(prepareYouTubePictureImport({ url: mediaReview.videoUrl, name: mediaReview.file.name }))
        setMediaReview(null)
        void publish()
      }} />}
    <div className="space-y-4" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">
        {t("importExport.youtube.description")}
      </p>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">{t("importExport.youtube.aboutCaptions")}</summary>
        <p className="mt-2">{t("importExport.youtube.captionHint")}</p>
      </details>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="font-medium">{t("importExport.youtube.source")}</legend>
        {(["picture", "captions", "media"] as const).map(value => <label
          key={value} className="flex items-center gap-2">
          <input type="radio" name={`${id}-source`} value={value}
            checked={source === value} onChange={() => { setSource(value); reset() }} />
          {t(value === "picture" ? "importExport.youtube.pictureOnly"
            : value === "captions" ? "importExport.youtube.captionExport"
              : "importExport.youtube.originalMedia")}
        </label>)}
      </fieldset>
      {source === "picture" && <div className="space-y-2">
        <label htmlFor={`${id}-name`}>{t("importExport.youtube.name")}</label>
        <Input id={`${id}-name`} value={name} disabled={busy}
          onChange={event => { setName(event.target.value); reset() }} />
        <p className="text-sm text-muted-foreground">{t("importExport.youtube.pictureHint")}</p>
      </div>}
      <div className="space-y-2">
        <label htmlFor={`${id}-url`}>{t("importExport.youtube.link")}</label>
        <Input id={`${id}-url`} type="url" value={url} disabled={busy}
          onChange={event => { setUrl(event.target.value); reset() }} />
      </div>
      {source === "captions" && <div className="space-y-2">
        <label htmlFor={`${id}-captions`}>{t("importExport.youtube.captions")}</label>
        <Input id={`${id}-captions`} type="file" accept=".vtt,.srt,.sbv"
          disabled={busy} onChange={event => {
            setFile(event.target.files?.[0] ?? null)
            reset()
          }} />
      </div>}
      {source === "media" && <div className="space-y-2">
        <label htmlFor={`${id}-media`}>{t("importExport.youtube.media")}</label>
        <Input id={`${id}-media`} type="file" accept="audio/*,video/*,.m4a"
          disabled={busy} onChange={event => {
            setMedia(event.target.files?.[0] ?? null)
            reset()
          }} />
        <p className="text-sm text-muted-foreground">{t("importExport.youtube.mediaHint")}</p>
      </div>}
      <Button onClick={() => void read()} disabled={busy || !url.trim()
        || (source === "captions" ? !file : source === "media" ? !media : !name.trim())}>
        {t(source === "captions" ? "importExport.youtube.preview" : "importExport.youtube.previewImport")}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {preview && <>
        {preview.strings.length === 0 ? <p className="font-medium">{preview.name}</p>
          : <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="p-2 text-left font-medium">{preview.name}</caption>
            <thead><tr>
              <th className="p-2 text-left">{t("importExport.youtube.time")}</th>
              <th className="p-2 text-left">{t("importExport.youtube.text")}</th>
            </tr></thead>
            <tbody>{preview.strings.map((cue, index) => <tr key={index}>
              <td className="whitespace-nowrap p-2 tabular-nums">
                {cue.start!.toFixed(3)}–{cue.end!.toFixed(3)}
              </td>
              <td className="whitespace-pre-wrap p-2">{cue.original}</td>
            </tr>)}</tbody>
          </table>
        </div>}
        <Button onClick={() => void publish()} disabled={busy}>
          {t(source === "captions" ? "importExport.youtube.import"
            : source === "media" ? "importExport.youtube.importMedia" : "importExport.youtube.linkVideo")}
        </Button>
      </>}
    </div>
    </>
  )
}
