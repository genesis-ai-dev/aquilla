import { Fragment, useMemo } from "react"
import { MessageSquare, Play } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CheckingRow } from "@/lib/checking/api"
import { checkingDocument, segmentMarker, type CheckingSegment } from "@/lib/checking/document"
import { checkingLabel } from "@/lib/checking/scope"
import { cn } from "@/lib/utils"

interface Props {
  rows: CheckingRow[]
  active: number
  /** Passage indexes that have a recording. */
  recorded: ReadonlySet<number>
  /** Feedback this guest has sent, per passage index. */
  sentCount: (index: number) => number
  onSelect: (index: number) => void
  onPlay: (index: number) => void
}

/** The shared passages as one readable document. Each passage is a tappable
 * segment in the running text; the open one is highlighted, and a passage with
 * a recording carries its own small play button. */
export function CheckingDocument({ rows, active, recorded, sentCount, onSelect, onPlay }: Props) {
  const t = useT()
  const sections = useMemo(() => checkingDocument(rows), [rows])
  const segment = ({ row, index }: CheckingSegment, heading = false) => {
    const label = checkingLabel(row.label, index)
    const sent = sentCount(index)
    // A <button> never wraps across lines, so a passage is an inline span with
    // button semantics: the text must flow like a page, not one verse per line.
    return <span key={index} data-segment={index} className="scroll-my-40">
      {recorded.has(index) && <button type="button" aria-label={t("projectSettings.checking.playPassage", { label })}
        onClick={() => onPlay(index)}
        className="me-1 inline-flex size-5 translate-y-0.5 items-center justify-center rounded-full bg-primary/10 align-baseline text-primary hover:bg-primary/20">
        <Play className="size-3 fill-current" />
      </button>}
      <span role="button" tabIndex={0} title={`${row.fileName} · ${label}`} aria-current={index === active ? "true" : undefined}
        onClick={() => onSelect(index)}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(index) } }}
        className={cn("cursor-pointer rounded-sm px-0.5 box-decoration-clone transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
          index === active && "bg-primary/30 hover:bg-primary/35")}>
        {!heading && <sup className="me-0.5 text-[0.65em] font-medium text-muted-foreground">{segmentMarker(label)}</sup>}
        {row.text}
        {sent > 0 && <MessageSquare aria-hidden className="ms-1 inline size-3 text-muted-foreground" />}
      </span>{" "}
    </span>
  }
  return <article aria-label={t("projectSettings.checking.passages")} dir="auto" className="flex flex-col gap-4 text-lg leading-relaxed">
    {sections.map(section => <Fragment key={section.fileId}>
      {sections.length > 1 && <h2 className="pt-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{section.fileName}</h2>}
      {section.blocks.map(block => block.kind === "heading"
        ? <h3 key={block.segments[0].index} className="text-xl font-semibold">{block.segments.map(item => segment(item, true))}</h3>
        : <p key={block.segments[0].index}>{block.segments.map(item => segment(item))}</p>)}
    </Fragment>)}
  </article>
}
