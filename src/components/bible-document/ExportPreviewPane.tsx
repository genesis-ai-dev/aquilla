// The live export preview (AQU-2559): the USFM file an export would write now.
// Lines that carry a translation are marked, so the translator sees what
// changed against the original and what still holds the source's words.

import { memo, useEffect, useMemo, useRef } from "react"
import type { UsfmPreview } from "@/lib/bible-document/export-plan"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { ExportPreviewState } from "./useUsfmExportPreview"

interface PreviewLine {
  text: string
  /** The first verse or heading whose words start on this line. */
  ref: string | null
  translated: boolean
}

interface PreviewChunk {
  key: string
  lines: PreviewLine[]
  /** Identity for memoization: the chunk repaints only when this changes. */
  signature: string
}

/** Split the file into lines, tag each with the span on it, and group the
 *  lines by chapter so a keystroke repaints one chapter, not the book. */
function previewChunks(preview: UsfmPreview): PreviewChunk[] {
  const chunks: PreviewChunk[] = []
  let lines: PreviewLine[] = []
  let chunkIndex = 0
  const close = () => {
    if (lines.length === 0) return
    chunks.push({ key: `chunk-${chunkIndex++}`, lines, signature: lines.map((l) => `${l.translated ? 1 : 0}${l.text}`).join("\n") })
    lines = []
  }
  const { text, spans } = preview
  let spanIndex = 0
  let offset = 0
  for (const raw of text.split("\n")) {
    const end = offset + raw.length
    while (spanIndex < spans.length && spans[spanIndex].end < offset) spanIndex++
    let ref: string | null = null
    let translated = false
    for (let i = spanIndex; i < spans.length && spans[i].start <= end; i++) {
      if (spans[i].end < offset) continue
      if (ref === null && spans[i].start >= offset) ref = spans[i].ref
      if (spans[i].state === "translated") translated = true
    }
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (/^\\c\s/.test(line)) close()
    lines.push({ text: line, ref, translated })
    offset = end + 1
  }
  close()
  return chunks
}

const MARKER = /(\\\+?[a-z]+\d*\*?)/g

const Chunk = memo(function Chunk({ chunk }: { chunk: PreviewChunk }) {
  return (
    <div className="[contain-intrinsic-size:auto_600px] [content-visibility:auto]">
      {chunk.lines.map((line, i) => (
        <div
          key={i}
          data-ref={line.ref ?? undefined}
          className={cn(
            "min-h-[1.5em] whitespace-pre-wrap break-words border-s-2 ps-2",
            line.translated ? "border-primary/60 bg-primary/[0.06]" : "border-transparent",
          )}
        >
          {line.text.split(MARKER).map((part, j) =>
            j % 2 === 1 ? <span key={j} className="text-muted-foreground">{part}</span> : part,
          )}
        </div>
      ))}
    </div>
  )
}, (a, b) => a.chunk.signature === b.chunk.signature)

export interface ExportPreviewPaneProps {
  state: ExportPreviewState
  /** The verse the translator is in; the preview keeps it in view. */
  activeRef: string | null
}

export function ExportPreviewPane({ state, activeRef }: ExportPreviewPaneProps) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const preview = state.status === "ready" ? state.preview : null
  const chunks = useMemo(() => (preview ? previewChunks(preview) : []), [preview])

  useEffect(() => {
    if (!activeRef || !rootRef.current) return
    const line = rootRef.current.querySelector(`[data-ref="${CSS.escape(activeRef)}"]`)
    line?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [activeRef])

  if (!preview) {
    const message =
      state.status === "forbidden" ? t("bibleDocument.preview.forbidden")
        : state.status === "unsupported" ? t("bibleDocument.preview.unsupported")
          : state.status === "error" ? t("bibleDocument.preview.error")
            : t("common.loading")
    return (
      <p role="status" aria-busy={state.status === "loading" || state.status === "idle"} className="p-4 text-sm text-muted-foreground">
        {message}
      </p>
    )
  }
  return (
    <div ref={rootRef} data-testid="export-preview-text" className="font-mono text-xs leading-6 text-foreground">
      {chunks.map((chunk) => <Chunk key={chunk.key} chunk={chunk} />)}
    </div>
  )
}
