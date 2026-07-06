import { type ReactNode, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FootnoteTextEditor } from "./FootnoteTextEditor"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"

export type FootnoteMarkerStyle = "numbered" | "lettered"

export interface AddFootnoteMarkerOption {
  label: string
  caller: string
  startCaller: string
  preview: string
  startPreview: string
  description: string
}

export interface AddFootnoteDialogValue {
  caller: string
  ref: string
  text: string
  markerStyle: FootnoteMarkerStyle
  startNewSequence: boolean
}

export interface AddFootnoteDialogDefaults {
  caller?: string
  ref?: string
  text?: string
  markerStyle?: FootnoteMarkerStyle
  anchorText?: string
  insertionPreview?: AddFootnoteInsertionPreview
  markerOptions?: Record<FootnoteMarkerStyle, AddFootnoteMarkerOption>
}

export interface AddFootnoteInsertionPreview {
  before: string
  after: string
}

interface AddFootnoteDialogProps {
  open: boolean
  defaults?: AddFootnoteDialogDefaults
  onOpenChange: (open: boolean) => void
  onAdd: (value: AddFootnoteDialogValue) => void
}

export function AddFootnoteDialog({
  open,
  defaults,
  onOpenChange,
  onAdd,
}: AddFootnoteDialogProps) {
  const [text, setText] = useState(() => footnoteTextWithAnchor(defaults?.anchorText, defaults?.text))
  const [markerStyle, setMarkerStyle] = useState<FootnoteMarkerStyle>(defaults?.markerStyle ?? "numbered")
  const markerOptions = defaults?.markerOptions ?? DEFAULT_MARKER_OPTIONS
  const caller = markerOptions[markerStyle].caller
  const ref = defaults?.ref ?? ""
  const initialAnchorPrefix = footnoteAnchorPrefix(defaults?.anchorText)
  const insertionPreview = defaults?.insertionPreview

  useEffect(() => {
    if (!open) return
    setText(footnoteTextWithAnchor(defaults?.anchorText, defaults?.text))
    setMarkerStyle(defaults?.markerStyle ?? "numbered")
  }, [defaults?.anchorText, defaults?.markerStyle, defaults?.text, open])

  const canAdd = text.trim().length > 0 && text.trim() !== initialAnchorPrefix.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add footnote</DialogTitle>
          <DialogDescription>
            Choose how the marker should appear, then add the note for this anchor.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="text-sm font-medium">Marker style</div>
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Footnote marker style">
              {(["numbered", "lettered"] satisfies FootnoteMarkerStyle[]).map((style) => {
                const option = markerOptions[style]
                const active = markerStyle === style
                const optionPreview = active ? markerLabel(caller, 1, option.preview) : option.preview
                return (
                  <button
                    key={style}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMarkerStyle(style)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border bg-background hover:bg-muted/60",
                    )}
                  >
                    <span className={cn(
                      "mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold",
                      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}>
                      {optionPreview}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <Field>
            <FieldLabel htmlFor="footnote-text">Footnote text</FieldLabel>
            <FootnoteTextEditor
              autoFocus
              rows={6}
              value={text}
              onChange={setText}
              placeholder="Selected text: footnote text..."
              ariaLabel="Footnote text"
              initialSelectionStart={open && initialAnchorPrefix ? initialAnchorPrefix.length : null}
            />
            <FieldDescription>
              {ref ? (
                <>
                  Attached to <span className="font-mono text-foreground">{ref}</span>.{" "}
                </>
              ) : null}
              Include the selected word or phrase before a colon when it helps clarify the note.
            </FieldDescription>
          </Field>

          {insertionPreview && (
            <div className="grid gap-1.5">
              <div className="text-sm font-medium">Target preview</div>
              <div className="max-h-28 overflow-auto rounded-md bg-muted px-3 py-2 text-sm leading-relaxed">
                {renderInsertionPreview(insertionPreview.before, caller, insertionPreview.after, false)}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canAdd}
            onClick={() => {
              if (!canAdd) return
              onAdd({ caller, ref, text, markerStyle, startNewSequence: false })
            }}
          >
            Add footnote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const DEFAULT_MARKER_OPTIONS: Record<FootnoteMarkerStyle, AddFootnoteMarkerOption> = {
  numbered: {
    label: "Numbering",
    caller: "+",
    startCaller: "1",
    preview: "1",
    startPreview: "1",
    description: "Use automatic numeric markers.",
  },
  lettered: {
    label: "Lettering",
    caller: "a",
    startCaller: "a",
    preview: "a",
    startPreview: "a",
    description: "Use letter markers for a separate note sequence.",
  },
}

function footnoteTextWithAnchor(anchorText: string | undefined, text: string | undefined): string {
  const anchorPrefix = footnoteAnchorPrefix(anchorText)
  const body = (text ?? "").trim()
  if (!anchorPrefix) return body
  if (!body) return anchorPrefix
  return body.startsWith(anchorPrefix) ? body : `${anchorPrefix}${body}`
}

function footnoteAnchorPrefix(anchorText: string | undefined): string {
  const anchor = (anchorText ?? "").trim()
  return anchor ? `${anchor}: ` : ""
}

const USFM_FOOTNOTE_RE = /\\f\s+([^\s\\]+)([\s\S]*?)\\f\*/g

function renderInsertionPreview(
  before: string,
  caller: string,
  after: string,
  startsNewSequence: boolean,
): ReactNode[] {
  const parts: ReactNode[] = []
  let ordinal = 0
  let key = 0
  renderPreviewText(before, parts, () => {
    ordinal += 1
    return ordinal
  }, () => key++)
  ordinal += 1
  parts.push(<PreviewMarker key={`inserted-${key++}`} label={markerLabel(caller, ordinal)} active />)
  if (startsNewSequence) ordinal = 0
  renderPreviewText(after, parts, () => {
    ordinal += 1
    return ordinal
  }, () => key++)
  return parts.length > 0 ? parts : [<span key="empty" className="text-muted-foreground">Empty cell</span>]
}

function renderPreviewText(
  text: string,
  parts: ReactNode[],
  nextOrdinal: () => number,
  nextKey: () => number,
) {
  let cursor = 0
  let match: RegExpExecArray | null
  const re = new RegExp(USFM_FOOTNOTE_RE.source, "g")
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push(<span key={`text-${nextKey()}`}>{text.slice(cursor, match.index)}</span>)
    }
    const ordinal = nextOrdinal()
    parts.push(<PreviewMarker key={`marker-${nextKey()}`} label={markerLabel(match[1], ordinal)} />)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) {
    parts.push(<span key={`text-${nextKey()}`}>{text.slice(cursor)}</span>)
  }
}

function markerLabel(caller: string | undefined, ordinal: number, fallback?: string): string {
  const trimmed = caller?.trim()
  if (trimmed && trimmed !== "+" && trimmed !== "-") return trimmed
  return fallback ?? String(ordinal)
}

function PreviewMarker({ label, active }: { label: string; active?: boolean }) {
  return (
    <sup
      className={cn(
        "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none",
        active ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
      )}
    >
      {label}
    </sup>
  )
}
