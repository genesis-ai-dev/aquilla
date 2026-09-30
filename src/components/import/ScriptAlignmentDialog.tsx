import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel } from "@/components/ui/field"
import { Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { scriptAlignmentCues, type ScriptAlignmentResult } from "@/lib/audio/script-alignment"
import type { TranslatableString } from "@/lib/parsers/core-types"

export interface ScriptAlignmentConfirmation {
  script: string
  scriptArtifact?: { name: string; bytes: ArrayBuffer }
  cues: TranslatableString[]
  signal: AbortSignal
  name?: string
  trackId?: string
  overwrite?: { contentFileId: string | null; segmentCount: number }
}
export interface AlignmentTrackDestination {
  id: string
  name: string
  contentFileId?: string
  segmentCount: number | null
}
interface Props {
  mediaName: string
  durationMs?: number
  tracks?: readonly AlignmentTrackDestination[]
  align(script: string, signal: AbortSignal): Promise<ScriptAlignmentResult>
  onConfirm(input: ScriptAlignmentConfirmation): Promise<void>
  onPreviewRange?(start: number, end: number): void
  onCancel(): void
}

/** Review stays local until confirmation. Failed saves retain all edits. */
export function ScriptAlignmentDialog({
  mediaName, durationMs, tracks, align, onConfirm, onCancel, onPreviewRange,
}: Props) {
  const t = useT()
  const [script, setScript] = useState("")
  const [scriptArtifact, setScriptArtifact] = useState<ScriptAlignmentConfirmation["scriptArtifact"]>()
  const [cues, setCues] = useState<TranslatableString[]>()
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [name, setName] = useState(t("importExport.scriptAlignment.trackNameDefault"))
  const [destination, setDestination] = useState("$new-track")
  const [overwriteConsent, setOverwriteConsent] = useState<{
    contentFileId: string | null; segmentCount: number
  } | null>(null)
  const selected = tracks?.find(track => track.id === destination)
  const replacing = destination !== "$new-track"
  const consent = Boolean(selected && overwriteConsent
    && overwriteConsent.contentFileId === (selected.contentFileId ?? null)
    && overwriteConsent.segmentCount === selected.segmentCount)
  const validDestination = tracks === undefined || (Boolean(name.trim())
    && name.length <= 120 && (!replacing || (consent && selected?.segmentCount !== null)))
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const validTiming = (cue: TranslatableString) =>
    Number.isFinite(cue.start) && Number.isFinite(cue.end)
    && cue.start! >= 0 && Math.round(cue.end! * 1000) > Math.round(cue.start! * 1000)
    && Number.isSafeInteger(Math.round(cue.end! * 1000))
    && (durationMs === undefined || Math.round(cue.end! * 1000) <= Math.round(durationMs))
  const valid = (cue: TranslatableString) => cue.original.trim().length > 0 && validTiming(cue)
  const canSave = validDestination && Boolean(cues?.length && cues.every(cue =>
    valid(cue) && (!cue.metadata?.alignmentNeedsReview || reviewed[cue.id]),
  ))
  function cancel() {
    controller.current?.abort()
    onCancel()
  }
  function edit(index: number, patch: Partial<TranslatableString>) {
    setCues(previous => previous?.map((cue, i) => i === index ? {
      ...cue, ...patch,
      metadata: { ...cue.metadata, alignmentManuallyEdited: true },
    } : cue))
    if (cues) setReviewed(previous => ({ ...previous, [cues[index].id]: false }))
  }
  async function loadScript(file: File) {
    if (busy) return
    const operation = new AbortController()
    controller.current = operation
    setBusy(true)
    setError(undefined)
    try {
      if (file.size > 800_000) throw new Error(t("importExport.scriptAlignment.fileLimit"))
      const bytes = await file.arrayBuffer()
      operation.signal.throwIfAborted()
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (text.length > 200_000) throw new Error(t("importExport.scriptAlignment.fileLimit"))
      setScript(text.replace(/\r\n?/g, "\n"))
      setScriptArtifact({ name: file.name, bytes })
    } catch (failure) {
      if (!operation.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (!operation.signal.aborted) setBusy(false)
    }
  }
  async function runAlignment() {
    if (busy || !script.trim()) return
    const operation = new AbortController()
    controller.current = operation
    setBusy(true)
    setError(undefined)
    try {
      const result = await align(script, operation.signal)
      if (operation.signal.aborted) return
      const next = scriptAlignmentCues(result)
      if (!next.length) throw new Error(t("importExport.scriptAlignment.empty"))
      setCues(next)
      setReviewed({})
    } catch (failure) {
      if (!operation.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (!operation.signal.aborted) setBusy(false)
    }
  }
  async function save() {
    if (busy || !canSave || !cues) return
    const operation = new AbortController()
    controller.current = operation
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm({ script, signal: operation.signal,
        ...(scriptArtifact ? { scriptArtifact } : {}),
        ...(tracks !== undefined ? { name: name.trim(),
          ...(replacing && selected && selected.segmentCount !== null ? {
            trackId: selected.id, overwrite: {
              contentFileId: selected.contentFileId ?? null, segmentCount: selected.segmentCount,
            },
          } : {}),
        } : {}),
        cues: cues.map(cue => ({ ...cue, metadata: {
          ...cue.metadata, alignmentReviewConfirmed: Boolean(reviewed[cue.id]),
        } })),
      })
    } catch (failure) {
      if (!operation.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (!operation.signal.aborted) setBusy(false)
    }
  }
  return <Dialog open onOpenChange={open => { if (!open) cancel() }}>
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t("importExport.scriptAlignment.title", { name: mediaName })}</DialogTitle>
        <DialogDescription>{t("importExport.scriptAlignment.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {error && <p role="alert">{error}</p>}
        <fieldset disabled={busy} className="space-y-4">
          {cues && tracks !== undefined && <div className="space-y-3">
            <Field><FieldLabel htmlFor="alignment-track-name">
              {t("importExport.scriptAlignment.trackName")}</FieldLabel>
              <Input id="alignment-track-name" value={name} maxLength={120}
                onChange={event => setName(event.target.value)} />
            </Field>
            <Field><FieldLabel htmlFor="alignment-track-destination">
              {t("importExport.scriptAlignment.destination")}</FieldLabel>
              <select id="alignment-track-destination" value={destination}
                onChange={event => { setDestination(event.target.value); setOverwriteConsent(null) }}>
                <option value="$new-track">{t("importExport.scriptAlignment.newTrack")}</option>
                {tracks.map(track => <option key={track.id} value={track.id}
                  disabled={track.segmentCount === null}>{track.name}</option>)}
              </select>
            </Field>
            {replacing && selected && selected.segmentCount !== null && <div className="flex items-center gap-2">
              <Checkbox id="alignment-overwrite" checked={consent} onCheckedChange={checked =>
                setOverwriteConsent(checked ? { contentFileId: selected.contentFileId ?? null,
                  segmentCount: selected.segmentCount! } : null)} />
              <FieldLabel htmlFor="alignment-overwrite">{t("importExport.scriptAlignment.overwrite", {
                count: selected.segmentCount,
              })}</FieldLabel>
            </div>}
          </div>}
          {!cues ? <><Field>
            <FieldLabel htmlFor="alignment-script-file">
              {t("importExport.scriptAlignment.file")}</FieldLabel>
            <Input id="alignment-script-file" type="file" accept=".txt,text/plain"
              onChange={event => {
                const file = event.target.files?.[0]
                if (file) void loadScript(file)
              }} />
          </Field><Field>
            <FieldLabel htmlFor="alignment-script">{t("importExport.scriptAlignment.script")}</FieldLabel>
            <Textarea id="alignment-script" value={script}
              onChange={event => setScript(event.target.value)} />
          </Field></> : cues.map((cue, i) => {
            const number = i + 1
            const prefix = `alignment-${cue.id}`
            return <div key={cue.id} className="space-y-3 rounded-md border p-3">
              <Field>
                <FieldLabel htmlFor={`${prefix}-wording`}>
                  {t("importExport.scriptAlignment.wording", { number })}
                </FieldLabel>
                <Textarea id={`${prefix}-wording`} value={cue.original}
                  onChange={event => edit(i, { original: event.target.value })} />
              </Field>
              <div className="flex gap-3">
                {(["start", "end"] as const).map(boundary => <Field key={boundary}>
                  <FieldLabel htmlFor={`${prefix}-${boundary}`}>
                    {t(`importExport.scriptAlignment.${boundary}`, { number })}
                  </FieldLabel>
                  <Input id={`${prefix}-${boundary}`} type="number" min={0} step="0.001"
                    value={cue[boundary] ?? ""} aria-invalid={!validTiming(cue)}
                    onChange={event => edit(i, { [boundary]:
                      event.target.value === "" ? undefined : Number(event.target.value) })} />
                </Field>)}
              </div>
              <Badge variant="secondary">{t(cue.metadata?.alignmentConfidenceBasis === "acoustic-score"
                ? "importExport.scriptAlignment.acousticScore" : "importExport.scriptAlignment.coverage", {
                percent: Math.round(Number(cue.metadata?.alignmentConfidence ?? 0) * 100),
              })}</Badge>
              {!valid(cue) && <p role="alert">{t("importExport.scriptAlignment.invalid")}</p>}
              {onPreviewRange && <Button variant="outline" size="sm"
                disabled={!validTiming(cue)} onClick={() => onPreviewRange(cue.start!, cue.end!)}>
                {t("importExport.scriptAlignment.listen", { number })}
              </Button>}
              {Boolean(cue.metadata?.alignmentNeedsReview) && <div className="flex items-center gap-2">
                <Checkbox id={`${prefix}-review`} checked={Boolean(reviewed[cue.id])} onCheckedChange={checked =>
                  setReviewed(previous => ({ ...previous, [cue.id]: Boolean(checked) }))} />
                <FieldLabel htmlFor={`${prefix}-review`}>
                  {t("importExport.scriptAlignment.review", { number })}
                </FieldLabel>
              </div>}
            </div>
          })}
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={cancel}>{t("common.cancel")}</Button>
        {cues && <Button variant="outline" disabled={busy} onClick={() => setCues(undefined)}>
          {t("importExport.scriptAlignment.retry")}
        </Button>}
        <Button disabled={busy || (cues ? !canSave : !script.trim())}
          onClick={() => void (cues ? save() : runAlignment())}>
          {busy ? t(cues ? "common.saving" : "importExport.scriptAlignment.aligning")
            : t(cues ? "importExport.scriptAlignment.use" : "importExport.scriptAlignment.align")}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
