import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { createMediaCueSpecs, type MediaTextSource, type MediaTextSourceOption } from "@/lib/import/media-cues"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  mediaName: string
  sources: readonly MediaTextSourceOption[]
  durationMs?: number
  allowAutomatic?: boolean
  title?: string
  description?: string
  confirmLabel?: string
  canConfirm?: boolean
  busy?: boolean
  children?: ReactNode
  onConfirm(source: MediaTextSource | undefined): void
  onCancel(): void
}

/** Mount once for each media file so selections never leak across imports. */
export function MediaImportPreviewDialog({
  mediaName, sources, durationMs, onConfirm, onCancel,
  allowAutomatic = true, title, description, confirmLabel,
  canConfirm = true, busy = false, children,
}: Props) {
  const t = useT()
  const [selectedId, setSelectedId] = useState(sources[0]?.id ?? "automatic")
  const [edits, setEdits] = useState<Record<string, MediaTextSource>>({})
  const selected = sources.find(source => source.id === selectedId)
  const source = selected ? edits[selected.id] ?? selected.source : undefined
  const issues = source?.cues.map(cue => {
    try {
      createMediaCueSpecs([cue], durationMs)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }) ?? []
  const invalidCount = issues.filter(Boolean).length
  const valid = source ? source.cues.length > 0 && invalidCount === 0 : allowAutomatic
  function updateCue(index: number, patch: Partial<MediaTextSource["cues"][number]>) {
    if (!source || !selected) return
    setEdits(previous => ({ ...previous, [selected.id]: {
      ...source,
      cues: source.cues.map((cue, i) => i === index ? { ...cue, ...patch } : cue),
    } }))
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title ?? t("importExport.mediaPreview.title", { name: mediaName })}</DialogTitle>
          <DialogDescription>{description ?? t("importExport.mediaPreview.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <fieldset disabled={busy} className="contents">
          <FieldGroup>
            {children}
            <Field>
              <FieldLabel>{t("importExport.mediaPreview.textSource")}</FieldLabel>
              <ToggleGroup value={[selectedId]} onValueChange={values => {
                if (values[0]) setSelectedId(values[0])
              }} variant="outline" aria-label={t("importExport.mediaPreview.textSource")}
                className="flex-wrap">
                {sources.map(option => <ToggleGroupItem key={option.id} value={option.id}>
                  {option.label}
                </ToggleGroupItem>)}
                {allowAutomatic && <ToggleGroupItem value="automatic">
                  {t("importExport.mediaPreview.automatic")}
                </ToggleGroupItem>}
              </ToggleGroup>
            </Field>
            {source ? <>
              <p role="status">
                {t("importExport.mediaPreview.segmentCount", { count: source.cues.length })}
                {invalidCount > 0 && ` · ${t("importExport.mediaPreview.needsAttention", { count: invalidCount })}`}
              </p>
              {source.cues.length === 0 && <FieldError>{t("importExport.mediaPreview.empty")}</FieldError>}
              {source.cues.map((cue, index) => {
                const number = index + 1
                const prefix = `media-preview-${index}`
                const issue = issues[index]
                const confidence = cue.metadata?.alignmentConfidence
                return <FieldGroup key={cue.id || index}>
                  <Field data-invalid={Boolean(issue)}>
                    <FieldLabel htmlFor={`${prefix}-text`}>
                      {t("importExport.mediaPreview.wording", { number })}
                    </FieldLabel>
                    <Textarea id={`${prefix}-text`} value={cue.original}
                      aria-invalid={Boolean(issue)} onChange={event => updateCue(index, { original: event.target.value })} />
                  </Field>
                  <FieldGroup className="flex-row">
                    <Field data-invalid={Boolean(issue)}>
                      <FieldLabel htmlFor={`${prefix}-start`}>{t("importExport.mediaPreview.start", { number })}</FieldLabel>
                      <Input id={`${prefix}-start`} type="number" min={0} step="0.001"
                        value={cue.start ?? ""} aria-invalid={Boolean(issue)}
                        onChange={event => updateCue(index, { start: event.target.value === "" ? undefined : Number(event.target.value) })} />
                    </Field>
                    <Field data-invalid={Boolean(issue)}>
                      <FieldLabel htmlFor={`${prefix}-end`}>{t("importExport.mediaPreview.end", { number })}</FieldLabel>
                      <Input id={`${prefix}-end`} type="number" min={0} step="0.001"
                        value={cue.end ?? ""} aria-invalid={Boolean(issue)}
                        onChange={event => updateCue(index, { end: event.target.value === "" ? undefined : Number(event.target.value) })} />
                    </Field>
                  </FieldGroup>
                  {typeof confidence === "number" && <Badge variant="secondary">
                    {t("importExport.mediaPreview.confidence", { percent: Math.round(confidence * 100) })}
                  </Badge>}
                  {issue && <FieldError>{issue.replace("Segment 1 ", "")}</FieldError>}
                  <Button variant="ghost" size="sm" onClick={() => {
                    if (selected) setEdits(previous => ({ ...previous, [selected.id]: {
                      ...source, cues: source.cues.filter((_, i) => i !== index),
                    } }))
                  }}>{t("importExport.mediaPreview.remove", { number })}</Button>
                </FieldGroup>
              })}
            </> : <p>{t("importExport.mediaPreview.automaticHint")}</p>}
          </FieldGroup>
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button disabled={!valid || !canConfirm || busy} onClick={() => {
            if (valid && canConfirm && !busy) onConfirm(source)
          }}>
            {busy ? t("common.saving") : confirmLabel ?? t("importExport.mediaPreview.continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
