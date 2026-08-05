import { useMemo, type ReactNode } from "react"
import DOMPurify from "dompurify"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  prepareReadOnlyRichTextHtml,
  sanitizeIdmlEditorHtml,
} from "@/lib/richtext/editor-content"
import {
  segmentUsfmForDisplay,
  type UsfmNoteSegment,
} from "@/lib/parsers/usfm-display"

export function UsfmNoteChip({
  note,
  ordinal,
  panelActive,
}: {
  note: UsfmNoteSegment
  ordinal: number
  panelActive?: boolean
}) {
  const label =
    note.noteKind === "xref" ? "†" : note.caller && note.caller !== "+" && note.caller !== "-" ? note.caller : String(ordinal)
  const kindLabel = note.noteKind === "xref" ? "Cross reference" : note.noteKind === "endnote" ? "Endnote" : "Footnote"
  const tooltipContent = (
    <div className="max-w-72 text-xs">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="text-[9px] font-medium text-muted-foreground">{kindLabel}</span>
        {note.ref && <span className="font-mono text-[10px] text-muted-foreground">{note.ref}</span>}
      </div>
      <div>{note.text || <span className="italic text-muted-foreground">(empty)</span>}</div>
    </div>
  )
  const chip = (
    <button
      type="button"
      className={cn(
        "mx-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-md bg-muted px-0.5 align-super text-[9px] font-bold leading-none text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary focus-visible:bg-primary/15 focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
        panelActive ? "cursor-default" : "cursor-help",
      )}
      aria-label={`${kindLabel}${note.ref ? ` ${note.ref}` : ""}`}
    >
      {label}
    </button>
  )

  return (
    <AppTooltip content={tooltipContent} side="bottom">
      {chip}
    </AppTooltip>
  )
}

/** Sanitized source-rich-text surface shared by the grid and agent workbench. */
export function SanitizedRichHtml({ html }: { html: string }) {
  const safeHtml = useMemo(() => DOMPurify.sanitize(html), [html])
  const innerHtml = useMemo(() => ({ __html: safeHtml }), [safeHtml])

  return (
    <div
      dangerouslySetInnerHTML={innerHtml}
    />
  )
}

/** Sanitized target-rich-text read surface shared by all editor layouts. */
export function TargetRichHtml({
  html,
  footnotePanelActive,
  footnoteNumberOffset = 0,
}: {
  html: string
  footnotePanelActive?: boolean
  footnoteNumberOffset?: number
}) {
  const safeHtml = useMemo(
    () => prepareReadOnlyRichTextHtml(html, {
      footnoteNumberOffset,
      showFootnoteTooltips: !footnotePanelActive,
    }),
    [footnoteNumberOffset, footnotePanelActive, html],
  )
  const innerHtml = useMemo(() => ({ __html: safeHtml }), [safeHtml])

  return (
    <div
      dangerouslySetInnerHTML={innerHtml}
    />
  )
}

export function TargetIdmlHtml({ html }: { html: string }) {
  const safeHtml = useMemo(() => sanitizeIdmlEditorHtml(html), [html])
  const innerHtml = useMemo(() => ({ __html: safeHtml }), [safeHtml])
  return (
    <div
      // Keep canonical slot identities in the read surface so a pointer click
      // can survive the subsequent ProseMirror remount.
      dangerouslySetInnerHTML={innerHtml}
    />
  )
}

/**
 * Lightweight plain/USFM reader for contexts that do not have the main
 * editor's terminology and violation decoration state available.
 */
export function EditorPlainReadText({
  text,
  emptyLabel,
  footnotePanelActive,
  footnoteNumberOffset = 0,
}: {
  text: string
  emptyLabel?: ReactNode
  footnotePanelActive?: boolean
  footnoteNumberOffset?: number
}) {
  const segments = useMemo(() => segmentUsfmForDisplay(text), [text])

  if (!text) return <>{emptyLabel}</>
  if (segments === null) return <span>{text}</span>

  let ordinal = footnoteNumberOffset
  const parts: ReactNode[] = []
  segments.forEach((segment, index) => {
    if (segment.kind === "break") {
      if (parts.length === 0) return
      parts.push(<br key={`br-${index}`} />)
      if (segment.blank) parts.push(<br key={`br2-${index}`} />)
      if (segment.indent > 0) {
        parts.push(
          <span
            key={`indent-${index}`}
            aria-hidden
            className="inline-block"
            style={{ width: `${segment.indent}em` }}
          />,
        )
      }
      return
    }
    if (segment.kind === "note") {
      ordinal += 1
      parts.push(
        <UsfmNoteChip
          key={`note-${index}`}
          note={segment}
          ordinal={ordinal}
          panelActive={footnotePanelActive}
        />,
      )
      return
    }
    parts.push(<span key={`text-${index}`}>{segment.text}</span>)
  })

  return <div>{parts}</div>
}
