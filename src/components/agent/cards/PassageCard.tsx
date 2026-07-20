/**
 * PassageCard — the live inline passage view under a read/draft tool chip
 * (agent-complete design §5).
 *
 * Renders what the tool was asked to display (aligned source/target rows)
 * AND lets the user move around inside the card: a side toggle
 * (Source | Target | Both) and chapter ‹ › navigation backed by a one-time
 * client-side fetch of the file's cells — no agent round-trip, no tokens.
 *
 * Every interaction reports the card's CURRENT view via `onActivity` (one
 * coalesced note per card), which the session store rides into the next
 * prompt's wire message — the model hears "the user is now looking at MRK 5
 * (target)" without the user having to say it.
 */

import { useMemo, useRef, useState } from "react"
import { BookOpen, ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { PassageRow } from "@/lib/agent/protocol"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"

const ROW_CAP = 12

export type PassageSide = "source" | "target" | "both"

export interface PassageCardProps {
  /** Stable per-card key (run-local item id) — the activity coalescing key. */
  cardKey: string
  /** What the tool displayed (initial view). */
  rows: PassageRow[]
  projectId: string
  /** Needed for in-card navigation; null → static card (no nav). */
  jwt: string | null
  /** Report the card's current view for the model's next turn. */
  onActivity?: (key: string, note: string) => void
  /** Injectable for tests. */
  fetchCells?: typeof fetchAllFileCells
}

/** "MRK 4:35" → { book: "MRK", chapter: 4 }. Null for non-scripture refs. */
export function parseChapterRef(ref: string | undefined): { book: string; chapter: number } | null {
  if (!ref) return null
  const m = ref.match(/^([1-3]?[A-Z]{2,3})\s+(\d+)/)
  return m ? { book: m[1], chapter: Number(m[2]) } : null
}

/** Pair a file's CellRows (side-split) into display rows in server order. */
export function pairCellRows(cells: CellRow[]): PassageRow[] {
  const byId = new Map<string, PassageRow>()
  for (const c of cells) {
    const row = byId.get(c.cellId) ?? { cellId: c.cellId, ref: c.canonicalRef ?? undefined, source: "", target: "" }
    if (c.side === "source") row.source = c.value
    else row.target = c.value
    if (!row.ref && c.canonicalRef) row.ref = c.canonicalRef
    byId.set(c.cellId, row)
  }
  return [...byId.values()]
}

function labelOf(rows: PassageRow[]): string {
  const refs = rows.map((r) => r.ref).filter((r): r is string => Boolean(r))
  if (refs.length === 0) return `${rows.length} cells`
  return refs.length === 1 || refs[0] === refs[refs.length - 1]
    ? refs[0]
    : `${refs[0]} – ${refs[refs.length - 1]}`
}

export function PassageCard({ cardKey, rows, projectId, jwt, onActivity, fetchCells = fetchAllFileCells }: PassageCardProps) {
  const [side, setSide] = useState<PassageSide>("both")
  const [shown, setShown] = useState<PassageRow[]>(rows)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [navError, setNavError] = useState<string | null>(null)
  // The file's full row set, fetched once on first navigation.
  const allRowsRef = useRef<PassageRow[] | null>(null)

  const initialLabel = useMemo(() => labelOf(rows), [rows])
  const fileId = rows.find((r) => r.fileId)?.fileId
  const chapter = parseChapterRef(shown[0]?.ref)
  const navigable = Boolean(fileId && jwt && chapter)

  const report = (nextRows: PassageRow[], nextSide: PassageSide) => {
    const where = labelOf(nextRows)
    const sideNote = nextSide === "both" ? "source + target" : `${nextSide} side`
    onActivity?.(
      `passage:${cardKey}`,
      `In the passage view that originally showed ${initialLabel}, the user is now looking at ${where} (${sideNote}).`,
    )
  }

  const changeSide = (next: PassageSide) => {
    setSide(next)
    report(shown, next)
  }

  const navigate = async (delta: 1 | -1) => {
    if (!fileId || !jwt || !chapter || loading) return
    setLoading(true)
    setNavError(null)
    try {
      allRowsRef.current ??= pairCellRows(await fetchCells(projectId, fileId, jwt))
      const all = allRowsRef.current
      const chapters = [...new Set(all.map((r) => parseChapterRef(r.ref)?.chapter).filter((c): c is number => c !== undefined))].sort((a, b) => a - b)
      const idx = chapters.indexOf(chapter.chapter)
      const target = chapters[idx + delta]
      if (target === undefined) return // already at the edge
      const next = all.filter((r) => parseChapterRef(r.ref)?.chapter === target)
      setShown(next)
      setExpanded(false)
      report(next, side)
    } catch (err) {
      setNavError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const visible = expanded ? shown : shown.slice(0, ROW_CAP)
  const hidden = shown.length - visible.length

  const SideButton = ({ value, label }: { value: PassageSide; label: string }) => (
    <button
      type="button"
      onClick={() => changeSide(value)}
      aria-pressed={side === value}
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px]",
        side === value ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-1.5 border-b px-2 py-1">
        <BookOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {labelOf(shown)}
        </span>
        <span className="flex items-center gap-0.5 rounded-md border p-0.5">
          <SideButton value="source" label="Source" />
          <SideButton value="target" label="Target" />
          <SideButton value="both" label="Both" />
        </span>
        {navigable && (
          <span className="flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void navigate(-1)}
              disabled={loading}
              aria-label="Previous chapter"
              className="text-muted-foreground"
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void navigate(1)}
              disabled={loading}
              aria-label="Next chapter"
              className="text-muted-foreground"
            >
              <ChevronRight />
            </Button>
          </span>
        )}
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="Loading chapter" />}
      </div>

      {navError && <p className="px-2 py-1 text-[10px] text-destructive">{navError}</p>}

      <div className="divide-y">
        {visible.map((row) => (
          <div key={row.cellId} className="grid grid-cols-[minmax(52px,auto)_1fr] gap-x-3 px-2 py-1 text-[11px]">
            <span className="font-mono text-[10px] text-muted-foreground">{row.ref ?? "·"}</span>
            <span className="min-w-0">
              {side !== "target" && (
                <span dir="auto" className="block whitespace-pre-wrap break-words text-muted-foreground">
                  {row.source || "∅"}
                </span>
              )}
              {side !== "source" && (
                <span dir="auto" className="block whitespace-pre-wrap break-words">
                  {row.target || "∅"}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full px-2 py-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
        >
          … {hidden} more — show all
        </button>
      )}
    </div>
  )
}
