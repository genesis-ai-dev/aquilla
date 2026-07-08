import { Bold, Italic, Underline as UnderlineIcon } from "lucide-react"
import type { KeyboardEvent, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

type FootnoteFormat = "bd" | "it" | "ul"

interface FootnoteTextEditorProps {
  value: string
  onChange: (value: string) => void
  rows?: number
  autoFocus?: boolean
  placeholder?: string
  ariaLabel: string
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  className?: string
  initialSelectionStart?: number | null
}

export function FootnoteTextEditor({
  value,
  onChange,
  rows = 3,
  autoFocus,
  placeholder,
  ariaLabel,
  onKeyDown,
  className,
  initialSelectionStart,
}: FootnoteTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (initialSelectionStart == null) return
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const position = Math.max(0, Math.min(initialSelectionStart, textarea.value.length))
      textarea.setSelectionRange(position, position)
    })
    return () => cancelAnimationFrame(frame)
  }, [initialSelectionStart])

  const applyFormat = (format: FootnoteFormat) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = value.slice(start, end)
    const fallback = format === "bd" ? "bold text" : format === "it" ? "italic text" : "underlined text"
    const body = selected || fallback
    const opening = `\\${format} `
    const closing = `\\${format}*`
    const next = `${value.slice(0, start)}${opening}${body}${closing}${value.slice(end)}`
    onChange(next)
    requestAnimationFrame(() => {
      textarea.focus()
      const selectionStart = start + opening.length
      const selectionEnd = selectionStart + body.length
      textarea.setSelectionRange(selectionStart, selectionEnd)
    })
  }

  return (
    <div className={cn("overflow-hidden rounded-md border border-input bg-background", className)}>
      <div className="flex items-center gap-1 border-b border-border/60 bg-muted/35 px-1.5 py-1">
        <FormatButton label="Bold" onClick={() => applyFormat("bd")}>
          <Bold className="h-3.5 w-3.5" />
        </FormatButton>
        <FormatButton label="Italic" onClick={() => applyFormat("it")}>
          <Italic className="h-3.5 w-3.5" />
        </FormatButton>
        <FormatButton label="Underline" onClick={() => applyFormat("ul")}>
          <UnderlineIcon className="h-3.5 w-3.5" />
        </FormatButton>
      </div>
      <Textarea
        ref={textareaRef}
        autoFocus={autoFocus}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoCorrect="off"
        spellCheck={false}
        className="min-h-0 resize-none rounded-none border-0 shadow-none focus-visible:ring-0"
      />
    </div>
  )
}

function FormatButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

export function renderFootnoteRichText(value: string): ReactNode[] {
  const parts: ReactNode[] = []
  const active = new Set<FootnoteFormat>()
  const markerRe = /\\(bd|it|ul)(\*)?\s*/g
  let cursor = 0
  let key = 0
  let match: RegExpExecArray | null

  while ((match = markerRe.exec(value)) !== null) {
    if (match.index > cursor) {
      parts.push(renderPart(value.slice(cursor, match.index), active, key++))
    }
    const format = match[1] as FootnoteFormat
    if (match[2]) active.delete(format)
    else active.add(format)
    cursor = markerRe.lastIndex
  }
  if (cursor < value.length) {
    parts.push(renderPart(value.slice(cursor), active, key++))
  }
  return parts.length > 0 ? parts : [value]
}

function renderPart(text: string, active: Set<FootnoteFormat>, key: number) {
  return (
    <span
      key={key}
      className={cn(
        active.has("bd") && "font-semibold",
        active.has("it") && "italic",
        active.has("ul") && "underline underline-offset-2",
      )}
    >
      {text}
    </span>
  )
}
