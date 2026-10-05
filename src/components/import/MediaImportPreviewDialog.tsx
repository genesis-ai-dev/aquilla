import { memo, useCallback, useMemo, useState, type ReactNode } from "react"
import { Pencil, X } from "lucide-react"
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
import { fmtCueClock, fmtDragTime } from "@/components/timeline/format"
import { parseTimecode } from "@/lib/timeline/timecode"
import { cn } from "@/lib/utils"
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

type Cue = MediaTextSource["cues"][number]
type CuePatch = Partial<Cue>

/** Why one cue cannot be imported, or null. `createMediaCueSpecs` names the
 *  cue "Segment 1" because it is checked on its own; the line it shows under
 *  already says which caption it is. */
function cueIssue(cue: Cue, durationMs: number | undefined): string | null {
  try {
    createMediaCueSpecs([cue], durationMs)
    return null
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).replace(/^Segment 1 /, "This caption ")
  }
}

const finite = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value)

/** `0:01 – 0:04`, or `–` for a side that has no usable time yet. */
function cueRange(cue: Cue): string {
  return `${finite(cue.start) ? fmtCueClock(cue.start) : "–"} – ${finite(cue.end) ? fmtCueClock(cue.end) : "–"}`
}

/**
 * Sam's D2 (2026-10-05): the review list is a COMPACT TABLE — one line per
 * caption, the time range as the timeline reads it (`0:01 – 0:04`) and the
 * wording. Every capability the old always-open fields had is kept: a line
 * opens in place to edit its wording and times, and an X drops it (some
 * projects forbid deleting rows later, so this is the moment to do it).
 *
 * Kept cheap for files with hundreds of captions: rows are memoised and their
 * callbacks are stable, so typing in one line re-renders that line only, and
 * `content-visibility: auto` lets the browser skip laying out lines that are
 * scrolled out of view.
 */
export function MediaImportPreviewDialog({
  mediaName, sources, durationMs, onConfirm, onCancel,
  allowAutomatic = true, title, description, confirmLabel,
  canConfirm = true, busy = false, children,
}: Props) {
  const t = useT()
  const [selectedId, setSelectedId] = useState(sources[0]?.id ?? "automatic")
  const [edits, setEdits] = useState<Record<string, MediaTextSource>>({})
  const [editing, setEditing] = useState<number | null>(null)
  const selected = sources.find(source => source.id === selectedId)
  const source = selected ? edits[selected.id] ?? selected.source : undefined
  const cues = source?.cues
  const issues = useMemo(() => cues?.map(cue => cueIssue(cue, durationMs)) ?? [], [cues, durationMs])
  const invalidCount = issues.filter(Boolean).length
  const valid = source ? source.cues.length > 0 && invalidCount === 0 : allowAutomatic
  const span = useMemo(() => {
    let first = Infinity
    let last = -Infinity
    for (const cue of cues ?? []) {
      if (finite(cue.start)) first = Math.min(first, cue.start)
      if (finite(cue.end)) last = Math.max(last, cue.end)
    }
    return first <= last ? `${fmtCueClock(first)}–${fmtCueClock(last)}` : null
  }, [cues])

  // Stable for as long as the chosen source is, so a memoised line never
  // re-renders because a neighbour changed.
  const editCues = useCallback((change: (cues: readonly Cue[]) => Cue[]) => {
    const option = sources.find(candidate => candidate.id === selectedId)
    if (!option) return
    setEdits(previous => {
      const current = previous[option.id] ?? option.source
      return { ...previous, [option.id]: { ...current, cues: change(current.cues) } }
    })
  }, [sources, selectedId])
  const updateCue = useCallback((index: number, patch: CuePatch) => {
    editCues(list => list.map((cue, i) => i === index ? { ...cue, ...patch } : cue))
  }, [editCues])
  const removeCue = useCallback((index: number) => {
    editCues(list => list.filter((_, i) => i !== index))
    setEditing(open => open === null || open < index ? open : open === index ? null : open - 1)
  }, [editCues])
  const toggleEdit = useCallback((index: number | null) => setEditing(index), [])

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
                if (values[0]) {
                  setSelectedId(values[0])
                  setEditing(null)
                }
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
            {source ? <div className="flex flex-col gap-2">
              <p role="status" data-testid="media-preview-summary" className="text-sm">
                {t("importExport.mediaPreview.captionCount", { count: source.cues.length })}
                {span && <span className="font-mono tabular-nums"> · {span}</span>}
                {invalidCount > 0 && <span className="text-destructive">
                  {` · ${t("importExport.mediaPreview.needsAttention", { count: invalidCount })}`}
                </span>}
              </p>
              {source.cues.length === 0 ? <FieldError>{t("importExport.mediaPreview.empty")}</FieldError> : (
                <ol aria-label={t("importExport.mediaPreview.listLabel")}
                  className="max-h-[min(55vh,32rem)] overflow-y-auto rounded-md border border-border">
                  {source.cues.map((cue, index) => <CueLine key={cue.id || index}
                    index={index} cue={cue} issue={issues[index] ?? null} editing={editing === index}
                    onToggleEdit={toggleEdit} onUpdate={updateCue} onRemove={removeCue} />)}
                </ol>
              )}
            </div> : <p>{t("importExport.mediaPreview.automaticHint")}</p>}
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

interface CueLineProps {
  index: number
  cue: Cue
  issue: string | null
  editing: boolean
  onToggleEdit(index: number | null): void
  onUpdate(index: number, patch: CuePatch): void
  onRemove(index: number): void
}

/** One caption: a single line at rest, its wording and times when open. */
const CueLine = memo(function CueLine({
  index, cue, issue, editing, onToggleEdit, onUpdate, onRemove,
}: CueLineProps) {
  const t = useT()
  const number = index + 1
  const confidence = cue.metadata?.alignmentConfidence
  return (
    <li data-testid="media-preview-row" data-invalid={issue ? true : undefined}
      className={cn(
        "border-b border-border px-2 py-1.5 text-sm last:border-b-0",
        // Lines scrolled out of the list are skipped until they come near.
        !editing && "[contain-intrinsic-size:auto_2.25rem] [content-visibility:auto]",
        editing && "bg-muted/40",
      )}>
      <div className="flex items-start gap-2">
        <span className="w-7 shrink-0 pt-0.5 text-end text-xs tabular-nums text-muted-foreground">{number}</span>
        <span className="w-[7.5rem] shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
          {cueRange(cue)}
        </span>
        {editing ? <span className="min-w-0 flex-1" /> : (
          // A click anywhere on the wording opens the line, as the pencil does.
          <span className="min-w-0 flex-1 cursor-text truncate" onClick={() => onToggleEdit(index)}>
            {cue.original.trim() ? cue.original
              : <em className="text-muted-foreground">{t("importExport.mediaPreview.noWording")}</em>}
          </span>
        )}
        {typeof confidence === "number" && <Badge variant="secondary">
          {t("importExport.mediaPreview.confidence", { percent: Math.round(confidence * 100) })}
        </Badge>}
        <Button variant="ghost" size="icon-xs" aria-label={t("importExport.mediaPreview.edit", { number })}
          aria-expanded={editing} onClick={() => onToggleEdit(editing ? null : index)}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={t("importExport.mediaPreview.remove", { number })}
          onClick={() => onRemove(index)}>
          <X />
        </Button>
      </div>
      {editing && <CueEditor index={index} cue={cue} invalid={Boolean(issue)}
        onUpdate={onUpdate} onDone={() => onToggleEdit(null)} />}
      {issue && <p role="alert" className="ms-9 mt-0.5 text-xs text-destructive">{issue}</p>}
    </li>
  )
})

/**
 * The open line. Times are typed the way the list shows them (`1:02.5`, or
 * bare seconds), read by the same lenient `parseTimecode` the text table's
 * timing popover uses, and seeded exactly (`00:02.712`) so nothing typed is
 * silently rounded. Anything unreadable leaves the cue without that time, so
 * the line is flagged and the import stays disabled until it is fixed.
 */
function CueEditor({ index, cue, invalid, onUpdate, onDone }: {
  index: number
  cue: Cue
  invalid: boolean
  onUpdate(index: number, patch: CuePatch): void
  onDone(): void
}) {
  const t = useT()
  const number = index + 1
  const [start, setStart] = useState(() => finite(cue.start) ? fmtDragTime(cue.start) : "")
  const [end, setEnd] = useState(() => finite(cue.end) ? fmtDragTime(cue.end) : "")
  const time = (
    side: "start" | "end",
    value: string,
    setValue: (next: string) => void,
  ) => (
    <Field data-invalid={invalid} className="w-32 gap-1">
      <FieldLabel htmlFor={`media-preview-${index}-${side}`} className="text-[11px] text-muted-foreground">
        {t(side === "start" ? "editor.cellMenu.startLabel" : "editor.cellMenu.endLabel")}
      </FieldLabel>
      <Input id={`media-preview-${index}-${side}`} value={value} inputMode="decimal"
        aria-label={t(side === "start" ? "importExport.mediaPreview.start" : "importExport.mediaPreview.end", { number })}
        aria-invalid={invalid} className="h-7 font-mono text-xs tabular-nums"
        onChange={event => {
          setValue(event.target.value)
          onUpdate(index, { [side]: parseTimecode(event.target.value) ?? undefined })
        }}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault()
            onDone()
          }
        }} />
    </Field>
  )
  return (
    <div className="ms-9 mt-1.5 flex flex-col gap-2 pe-1">
      <Textarea id={`media-preview-${index}-text`} autoFocus value={cue.original} rows={2}
        aria-label={t("importExport.mediaPreview.wording", { number })} aria-invalid={invalid}
        onChange={event => onUpdate(index, { original: event.target.value })} />
      <div className="flex flex-wrap items-end gap-2">
        {time("start", start, setStart)}
        {time("end", end, setEnd)}
        <Button size="sm" variant="outline" className="ms-auto" onClick={onDone}>{t("common.done")}</Button>
      </div>
    </div>
  )
}
