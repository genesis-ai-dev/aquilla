import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n/I18nProvider"
import type { EmitParsedFileResult, ImportContext } from "@/lib/import"
import { decodeImportText } from "@/lib/import/ai-recipe"
import { createYouTubeCaptionCommit } from "@/lib/import/youtube-caption-commit"
import { prepareYouTubeCaptionImport,
  type PreparedYouTubeCaptionImport } from "@/lib/import/youtube-captions"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import type { FileReference } from "@/lib/parsers/types"

export function YouTubeImportPanel({ ctx, onImported }: {
  ctx: ImportContext
  onImported: (refs: FileReference[]) => void | Promise<void>
}) {
  const t = useT()
  const id = useId()
  const [url, setUrl] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<PreparedYouTubeCaptionImport | null>(null)
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
    if (!file || busy) return
    const active = controller.current
    setBusy(true)
    reset()
    try {
      assertSourceUploadByteLength(file.size)
      const bytes = await file.arrayBuffer()
      active.signal.throwIfAborted()
      const prepared = prepareYouTubeCaptionImport({
        url, captionName: file.name,
        captionText: decodeImportText(bytes, file.name), rawBytes: bytes,
      })
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
    <div className="space-y-4" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">
        {t("importExport.youtube.description")}
      </p>
      <div className="space-y-2">
        <label htmlFor={`${id}-url`}>{t("importExport.youtube.link")}</label>
        <Input id={`${id}-url`} type="url" value={url} disabled={busy}
          onChange={event => { setUrl(event.target.value); reset() }} />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-captions`}>{t("importExport.youtube.captions")}</label>
        <Input id={`${id}-captions`} type="file" accept=".vtt,.srt,.sbv"
          disabled={busy} onChange={event => {
            setFile(event.target.files?.[0] ?? null)
            reset()
          }} />
      </div>
      <Button onClick={() => void read()} disabled={busy || !file || !url.trim()}>
        {t("importExport.youtube.preview")}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {preview && <>
        <div className="max-h-72 overflow-auto rounded-md border">
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
        </div>
        <Button onClick={() => void publish()} disabled={busy}>
          {t("importExport.youtube.import")}
        </Button>
      </>}
    </div>
  )
}
