// The source side of the Bible document (AQU-2559): the book as it reads, in
// its own paragraphs, poetry lines and headings. Read-only; a click on a verse
// takes the translation side to the same verse.

import { memo, useMemo, type ReactNode } from "react"
import { CHAPTER_CLASS, HEADING_CLASS, VERSE_CHIP_CLASS } from "@/lib/bible-document/editor-extensions"
import type { DocUnit } from "@/lib/bible-document/units"
import { segmentUsfmForDisplay, type UsfmInlineMark } from "@/lib/parsers/usfm-display"
import { cn } from "@/lib/utils"

type SourceBlock =
  | { kind: "chapter"; key: string; chapter: number }
  | { kind: "heading"; key: string; unit: DocUnit }
  | { kind: "para"; key: string; marker: string; units: DocUnit[] }

function sourceBlocks(units: readonly DocUnit[]): SourceBlock[] {
  const blocks: SourceBlock[] = []
  let para: Extract<SourceBlock, { kind: "para" }> | null = null
  let lastChapter: number | null = null
  for (const unit of units) {
    if (unit.kind === "verse" && unit.chapter !== null && unit.chapter > 0 && unit.chapter !== lastChapter) {
      blocks.push({ kind: "chapter", key: `c${unit.chapter}`, chapter: unit.chapter })
      para = null
      lastChapter = unit.chapter
    }
    if (unit.kind === "heading") {
      blocks.push({ kind: "heading", key: unit.cellId, unit })
      para = null
      continue
    }
    if (para === null || unit.sourceParagraphStart) {
      para = { kind: "para", key: `p${unit.cellId}`, marker: unit.sourceParagraphMarker ?? "p", units: [] }
      blocks.push(para)
    }
    para.units.push(unit)
  }
  return blocks
}

const MARK_CLASS: Record<UsfmInlineMark, string> = {
  bold: "font-semibold",
  italic: "italic",
  "small-caps": "[font-variant:small-caps]",
  superscript: "align-super text-[0.7em]",
}

function VerseWords({ text }: { text: string }) {
  const segments = useMemo(() => segmentUsfmForDisplay(text), [text])
  if (segments === null) return <>{text}</>
  const parts: ReactNode[] = []
  segments.forEach((seg, i) => {
    if (seg.kind === "break") {
      if (parts.length === 0) return
      parts.push(<br key={`b${i}`} />)
      if (seg.blank) parts.push(<br key={`bb${i}`} />)
      if (seg.indent > 0) parts.push(<span key={`in${i}`} aria-hidden className="inline-block" style={{ width: `${seg.indent}em` }} />)
    } else if (seg.kind === "note") {
      parts.push(
        <span key={`n${i}`} title={seg.text} className="mx-0.5 cursor-default select-none rounded bg-muted px-1 align-super text-[0.62em] font-semibold text-muted-foreground">
          †
        </span>,
      )
    } else {
      parts.push(<span key={`t${i}`} className={seg.marks.map((m) => MARK_CLASS[m]).join(" ") || undefined}>{seg.text}</span>)
    }
  })
  return <>{parts}</>
}

const PARA_CLASS: Record<string, string> = {
  p: "indent-5", pi: "ps-6", pi1: "ps-6", mi: "ps-6",
  q: "ps-8 -indent-4", q1: "ps-8 -indent-4", q2: "ps-12 -indent-4", q3: "ps-16 -indent-4", q4: "ps-20 -indent-4",
  qm: "ps-10", qm1: "ps-10", li: "ps-8", li1: "ps-8", li2: "ps-12",
  qc: "text-center", pc: "text-center", qr: "text-end", pr: "text-end",
}

const Block = memo(function Block({ block, activeCellId, onPickCell }: { block: SourceBlock; activeCellId: string | null; onPickCell: (cellId: string) => void }) {
  if (block.kind === "chapter") return <div className={CHAPTER_CLASS} data-chapter={block.chapter}>{block.chapter}</div>
  if (block.kind === "heading") {
    return (
      <h3 className={cn(HEADING_CLASS, "cursor-pointer")} data-cell-id={block.unit.cellId} data-marker={block.unit.headingMarker ?? "s1"} onClick={() => onPickCell(block.unit.cellId)}>
        {block.unit.source}
      </h3>
    )
  }
  return (
    <p className={cn("my-0 leading-[1.75]", PARA_CLASS[block.marker])} data-marker={block.marker}>
      {block.units.map((unit) => (
        <span
          key={unit.cellId}
          data-cell-id={unit.cellId}
          onClick={() => onPickCell(unit.cellId)}
          className={cn("cursor-pointer rounded-sm", unit.cellId === activeCellId && "bg-primary/[0.07]")}
        >
          <span className={VERSE_CHIP_CLASS}>{unit.label || "•"}</span>
          <VerseWords text={unit.source} />{" "}
        </span>
      ))}
    </p>
  )
}, (a, b) => {
  if (a.block !== b.block || a.onPickCell !== b.onPickCell) return false
  if (a.activeCellId === b.activeCellId) return true
  // Only the blocks that hold the old or the new active verse repaint.
  const holds = (block: SourceBlock, id: string | null) =>
    id !== null && (block.kind === "para" ? block.units.some((u) => u.cellId === id) : block.kind === "heading" && block.unit.cellId === id)
  return !holds(a.block, a.activeCellId) && !holds(b.block, b.activeCellId)
})

export interface SourceDocumentPaneProps {
  units: readonly DocUnit[]
  activeCellId: string | null
  onPickCell: (cellId: string) => void
  dir?: "ltr" | "rtl"
  fontSize?: number
}

/** Blocks are rebuilt only when a source field changes, so typing a
 *  translation does not repaint this pane. */
function sourceKey(units: readonly DocUnit[]): string {
  return units.map((u) => `${u.cellId}\u0001${u.source}\u0001${u.sourceParagraphStart ? u.sourceParagraphMarker ?? "p" : ""}\u0001${u.label}`).join("\u0002")
}

export function SourceDocumentPane({ units, activeCellId, onPickCell, dir, fontSize }: SourceDocumentPaneProps) {
  const key = useMemo(() => sourceKey(units), [units])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the source fields of `units`
  const blocks = useMemo(() => sourceBlocks(units), [key])
  return (
    <div dir={dir} className="font-serif text-foreground" style={fontSize ? { fontSize: `${fontSize}px` } : undefined}>
      {blocks.map((block) => (
        <Block key={block.key} block={block} activeCellId={activeCellId} onPickCell={onPickCell} />
      ))}
    </div>
  )
}
