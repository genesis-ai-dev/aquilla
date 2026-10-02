import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { prepareImportFile } from "@/lib/import"
import { detectFileType } from "@/lib/parsers/types"
import type { MediaTextSource } from "@/lib/import/media-cues"
import type { ImportTimelineTextTrackArgs } from "@/lib/import/timeline-text"
import { MediaImportPreviewDialog } from "./MediaImportPreviewDialog"

export interface CaptionTrackDestination {
  id: string
  name: string
  contentFileId?: string
  /** null means this track's current content has not loaded successfully. */
  segmentCount: number | null
}
export type CaptionTrackConfirmation = Pick<ImportTimelineTextTrackArgs,
  "source" | "name" | "trackId" | "overwrite" | "signal">
/** AQU-1566: what "Add captions as rows" hands back. There is no track to name
 *  or replace: the captions become the file's own rows. */
export type CaptionRowsConfirmation = Pick<ImportTimelineTextTrackArgs, "source" | "signal">
interface CommonProps {
  projectId: string
  mediaName: string
  durationMs?: number
  onCancel(): void
}
type Props = CommonProps & ({
  /** A timeline-only caption track (the default). */
  mode?: "track"
  tracks: readonly CaptionTrackDestination[]
  onConfirm(input: CaptionTrackConfirmation): Promise<void>
} | {
  /** AQU-1566 (option b): a linked video with no rows takes these captions as
   *  its own rows, so there is no destination or name to choose. */
  mode: "rows"
  onConfirm(input: CaptionRowsConfirmation): Promise<void>
})
const NEW_TRACK = "$new-track"
const NO_TRACKS: readonly CaptionTrackDestination[] = []

/** The default is always a new track. Existing content requires both a named
 * destination and counted consent; a failed save keeps all reviewed edits.
 * In rows mode the same pick-and-review flow ends in "Add captions as rows".
 */
export function ImportTimelineTextDialog(props: Props) {
  const { projectId, mediaName, durationMs, onCancel } = props
  const rows = props.mode === "rows"
  const tracks = props.mode === "rows" ? NO_TRACKS : props.tracks
  const t = useT()
  const [source, setSource] = useState<MediaTextSource>()
  const [name, setName] = useState("")
  const [destination, setDestination] = useState(NEW_TRACK)
  const [consentSnapshot, setConsentSnapshot] = useState<{
    contentFileId: string | null; segmentCount: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const cancel = () => { controller.current?.abort(); onCancel() }
  const selected = tracks.find(track => track.id === destination)
  const replacing = destination !== NEW_TRACK
  const consent = Boolean(selected && consentSnapshot
    && consentSnapshot.contentFileId === (selected.contentFileId ?? null)
    && consentSnapshot.segmentCount === selected.segmentCount)
  const canConfirm = rows || (Boolean(name.trim()) && name.length <= 120
    && (!replacing || (consent && selected && selected.segmentCount !== null)))

  async function read(file: File) {
    const format = detectFileType(file.name)
    if (format !== "srt" && format !== "vtt" && format !== "sbv") {
      setError(t("importExport.captionTrack.invalidFile"))
      return
    }
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    setBusy(true)
    setError(undefined)
    try {
      const prepared = await prepareImportFile(file, { projectId, signal: pending.signal })
      const bytes = prepared.results[0]?.rawBytes ?? await file.arrayBuffer()
      if (pending.signal.aborted) return
      setSource({ cues: prepared.results.flatMap(result => result.strings),
        artifact: { name: file.name, format, bytes } })
      setName(file.name.replace(/\.[^.]+$/, "").slice(0, 120))
    } catch (cause) {
      if (!pending.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!pending.signal.aborted) setBusy(false)
    }
  }

  async function confirm(reviewed: MediaTextSource | undefined) {
    if (!reviewed || !canConfirm || busy) return
    const pending = new AbortController()
    controller.current = pending
    setBusy(true)
    setError(undefined)
    try {
      if (props.mode === "rows") await props.onConfirm({ source: reviewed, signal: pending.signal })
      else await props.onConfirm({ source: reviewed, name: name.trim(), signal: pending.signal,
        trackId: replacing ? selected?.id : undefined,
        overwrite: replacing && selected && selected.segmentCount !== null ? {
          contentFileId: selected.contentFileId ?? null, segmentCount: selected.segmentCount,
        } : undefined,
      })
      if (!pending.signal.aborted) onCancel()
    } catch (cause) {
      if (!pending.signal.aborted) setError(cause instanceof Error ? cause.message
        : t("importExport.captionTrack.saveFailed"))
    } finally {
      if (!pending.signal.aborted) setBusy(false)
    }
  }

  const title = t("importExport.captionTrack.title", { name: mediaName })
  const description = t(rows ? "importExport.captionTrack.rowsDescription"
    : "importExport.captionTrack.description")
  if (!source) return <Dialog open onOpenChange={open => { if (!open) cancel() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <DialogBody><FieldGroup>
        <Field><FieldLabel htmlFor="timeline-caption-file">{t("importExport.captionTrack.file")}</FieldLabel>
          <Input id="timeline-caption-file" type="file" accept=".vtt,.srt,.sbv" disabled={busy}
            onChange={event => { const file = event.target.files?.[0]; if (file) void read(file) }} />
        </Field>
        {busy && <p role="status">{t("common.loading")}</p>}
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup></DialogBody>
      <DialogFooter><Button variant="outline" onClick={cancel}>{t("common.cancel")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
  return <MediaImportPreviewDialog mediaName={mediaName}
    sources={[{ id: "captions", label: source.artifact?.name ?? name, source }]}
    durationMs={durationMs} allowAutomatic={false} title={title} description={description}
    confirmLabel={t(rows ? "importExport.captionTrack.addAsRows"
      : replacing ? "importExport.captionTrack.replace" : "importExport.captionTrack.add")}
    canConfirm={canConfirm} busy={busy} onConfirm={reviewed => void confirm(reviewed)} onCancel={cancel}>
    {!rows && <>
      <Field><FieldLabel htmlFor="caption-destination">{t("importExport.captionTrack.destination")}</FieldLabel>
        <select id="caption-destination" value={destination} disabled={busy}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          onChange={event => {
            setDestination(event.target.value)
            setConsentSnapshot(null)
            const target = tracks.find(track => track.id === event.target.value)
            if (target) setName(target.name)
          }}>
          <option value={NEW_TRACK}>{t("importExport.captionTrack.new")}</option>
          {tracks.map(track => <option key={track.id} value={track.id} disabled={track.segmentCount === null}>
            {track.name}
          </option>)}
        </select>
      </Field>
      <Field><FieldLabel htmlFor="caption-track-name">{t("importExport.captionTrack.name")}</FieldLabel>
        <Input id="caption-track-name" value={name} maxLength={120} disabled={busy}
          onChange={event => setName(event.target.value)} />
      </Field>
      {replacing && selected && selected.segmentCount !== null && <>
        <p>{t("importExport.captionTrack.overwrite", { count: selected.segmentCount })}</p>
        <Field orientation="horizontal"><Checkbox id="caption-overwrite-consent" checked={consent}
          disabled={busy} onCheckedChange={checked => setConsentSnapshot(
            checked && selected.segmentCount !== null ? {
              contentFileId: selected.contentFileId ?? null, segmentCount: selected.segmentCount,
            } : null,
          )} />
          <FieldLabel htmlFor="caption-overwrite-consent">{t("importExport.captionTrack.consent")}</FieldLabel>
        </Field>
      </>}
    </>}
    {error && <FieldError>{error}</FieldError>}
  </MediaImportPreviewDialog>
}
