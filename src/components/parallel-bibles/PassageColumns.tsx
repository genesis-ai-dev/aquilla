// The whole-passage view: one column per pinned version, each showing the
// whole chapter, kept in step with the editor — when the tracked verse moves,
// every column scrolls to its own copy of that verse and highlights it.
// Hebrew-numbered columns follow their own numbering (versification.ts) and
// say so above the text.

import { Fragment, useEffect, useRef } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { HelloaoTranslation } from "@/lib/parsers/helloao"
import type { VersionAlignment } from "@/lib/parallel-bibles/versification"
import { verseTextPresentation, verseTextStyle } from "@/lib/parallel-bibles/version-display"
import { cn } from "@/lib/utils"
import { ResourcePaneError } from "../ResourcePaneError"
import type { ChapterData, PassageBlock } from "./chapter-data"
import { VersificationMark } from "./VersificationMark"
import { VersionCredit } from "./VersionCredit"

export interface PassageColumn {
  versionId: string
  label: string
  meta: HelloaoTranslation | undefined
  book: string
  alignment: VersionAlignment
  data: ChapterData | undefined
}

/** Verses run on as one paragraph; a heading starts a new one. */
function paragraphs(blocks: PassageBlock[]): PassageBlock[][] {
  const out: PassageBlock[][] = []
  let run: PassageBlock[] = []
  for (const block of blocks) {
    if (block.type === "heading") {
      if (run.length) out.push(run)
      out.push([block])
      run = []
    } else {
      run.push(block)
    }
  }
  if (run.length) out.push(run)
  return out
}

function Column({
  column,
  onRetry,
  onRemove,
}: {
  column: PassageColumn
  onRetry: () => void
  onRemove: () => void
}) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const { versionId, label, meta, book, alignment, data } = column
  const highlight = alignment.verse
  const presentation = verseTextPresentation(meta)
  const text = verseTextStyle(presentation, "passage")
  const chapterLabel = `${book} ${alignment.chapter}`

  // Keep this column in step: bring the tracked verse a third of the way down.
  useEffect(() => {
    const box = scroller.current
    if (!box || highlight === null || !data) return
    const el = box.querySelector<HTMLElement>(`[data-verse="${highlight}"]`)
    if (!el) return
    const top = Math.max(0, el.offsetTop - box.clientHeight / 3)
    if (typeof box.scrollTo === "function") box.scrollTo({ top, behavior: "smooth" })
    else box.scrollTop = top
  }, [highlight, data])

  return (
    <section
      aria-label={label}
      data-testid={`passage-column-${versionId}`}
      className="flex min-h-0 min-w-[180px] flex-1 basis-0 flex-col border-e last:border-e-0"
    >
      <header className="group flex items-center justify-between gap-1 border-b px-2 py-1.5">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {label}
          <span className="ms-1.5 font-mono text-[10px] text-muted-foreground/70">{chapterLabel}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("editor.bibles.removeVersion", { version: versionId })}
          onClick={onRemove}
          className="text-muted-foreground/0 transition-colors hover:text-foreground group-hover:text-muted-foreground"
        >
          <X />
        </Button>
      </header>
      {alignment.note && <VersificationMark note={alignment.note} className="mx-2 mt-1.5" />}
      <div
        ref={scroller}
        dir={presentation.dir}
        lang={presentation.lang}
        style={text.style}
        className={cn("relative min-h-0 flex-1 overflow-y-auto px-3 py-2 text-start text-foreground/90", text.className)}
      >
        {data?.error ? (
          <ResourcePaneError
            message={data.error}
            onRetry={onRetry}
            retryLabel={t("editor.bibles.retryVersion", { version: versionId })}
          />
        ) : !data ? (
          <div className="flex items-center text-muted-foreground" aria-label={t("common.loading")}>
            <Spinner className="size-3.5" />
          </div>
        ) : data.blocks.length === 0 ? (
          <p className="font-sans text-xs text-muted-foreground">
            {t("editor.bibles.noTextForRef", { ref: chapterLabel })}
          </p>
        ) : (
          paragraphs(data.blocks).map((para, i) =>
            para[0]?.type === "heading" ? (
              <p
                key={i}
                className={cn(
                  "mb-1.5 mt-2 first:mt-0 text-[0.8em] font-semibold text-muted-foreground",
                  para[0].psalmTitle && "font-normal italic",
                )}
              >
                {para[0].text}
              </p>
            ) : (
              <p key={i} className="mb-2">
                {para.map((block) =>
                  block.type === "verse" ? (
                    <Fragment key={block.number}>
                      <span
                        data-verse={block.number}
                        aria-current={block.number === highlight ? "true" : undefined}
                        className={cn(
                          "rounded-sm transition-colors",
                          block.number === highlight && "bg-primary/15",
                        )}
                      >
                        <sup className="me-0.5 font-sans text-[0.6em] text-muted-foreground">{block.number}</sup>
                        {block.text}
                      </span>{" "}
                    </Fragment>
                  ) : null,
                )}
              </p>
            ),
          )
        )}
      </div>
      <div className="border-t px-2 py-1.5">
        <VersionCredit versionId={versionId} meta={meta} />
      </div>
    </section>
  )
}

export function PassageColumns({
  columns,
  onRetry,
  onRemove,
}: {
  columns: PassageColumn[]
  onRetry: (column: PassageColumn) => void
  onRemove: (versionId: string) => void
}) {
  return (
    <div data-testid="passage-columns" className="flex h-full min-h-0 overflow-x-auto">
      {columns.map((column) => (
        <Column
          key={column.versionId}
          column={column}
          onRetry={() => onRetry(column)}
          onRemove={() => onRemove(column.versionId)}
        />
      ))}
    </div>
  )
}
