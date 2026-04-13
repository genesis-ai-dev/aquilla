import { useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as Y from "yjs"
import DOMPurify from "dompurify"
import type { CellData } from "@/hooks/useCells"

interface EditorTableProps {
  cells: CellData[]
  doc: Y.Doc
}

export function EditorTable({ cells, doc }: EditorTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: cells.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
  })

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div className="sticky top-0 z-10 grid grid-cols-2 gap-2 border-b bg-background px-4 py-2 text-sm font-medium text-muted-foreground">
        <div>Source</div>
        <div>Target</div>
      </div>

      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const cell = cells[virtualRow.index]
          return (
            <div
              key={cell.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <EditorRow cell={cell} doc={doc} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EditorRow({ cell, doc }: { cell: CellData; doc: Y.Doc }) {
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const cellsMap = doc.getMap("cells")
    const yCell = cellsMap.get(cell.id) as Y.Map<string>
    if (yCell) {
      doc.transact(() => {
        yCell.set("translated", e.target.value)
      })
    }
  }

  // SECURITY: originalHtml is sanitized through DOMPurify.sanitize() at the
  // render boundary. Parsers only produce safe inline tags (<b>, <i>, <u>,
  // <s>, <code>). DOMPurify provides defense-in-depth against XSS.
  return (
    <div className="grid grid-cols-2 gap-2 border-b px-4 py-2">
      <div>
        <span className="mb-1 block text-xs text-muted-foreground">
          {cell.context}
        </span>
        {cell.originalHtml ? (
          <div
            className="text-sm"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(cell.originalHtml),
            }}
          />
        ) : (
          <div className="text-sm">{cell.original}</div>
        )}
      </div>

      <div>
        <textarea
          className="w-full resize-none rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          value={cell.translated}
          onChange={handleChange}
          rows={Math.max(2, Math.ceil(cell.original.length / 50))}
        />
      </div>
    </div>
  )
}
