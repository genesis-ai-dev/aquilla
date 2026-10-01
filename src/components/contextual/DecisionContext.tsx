// DecisionContext — the "where does this apply?" half of a DecisionCard.
//
// Always visible: the file and passage the question is about, plus a link
// that opens the editor on it. One click further: the affected verses with
// their source and current translation. One more: the verses around them, so
// a reader can judge the question in its context rather than in isolation.

import { ExternalLink, MapPin } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  loadDecisionPlace,
  loadDecisionSurroundings,
  type DecisionCellView,
  type DecisionPlace,
} from "@/lib/contextual/decision-context"
import { editorCellHref } from "@/components/project-workspace-lane-deeplink"

export interface DecisionContextProps {
  projectId: string
  fileId: string
  cellIds: string[]
}

type Load<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T }

function CellList({ cells }: { cells: DecisionCellView[] }) {
  const t = useT()
  return (
    <ol className="flex flex-col gap-1.5">
      {cells.map((cell) => (
        <li
          key={cell.cellId}
          data-affected={cell.affected || undefined}
          className={cn(
            "grid grid-cols-[auto_1fr] gap-x-2 rounded-md px-2 py-1 text-xs select-text",
            cell.affected ? "bg-amber-500/10" : "text-muted-foreground",
          )}
        >
          <span className="font-mono text-[10px] text-muted-foreground">{cell.ref ?? ""}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="break-words">{cell.source}</p>
            <p className={cn("break-words", !cell.target && "italic text-muted-foreground")}>
              {cell.target || t("autopilot.decisions.context.untranslated")}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

export function DecisionContext({ projectId, fileId, cellIds }: DecisionContextProps) {
  const t = useT()
  const [place, setPlace] = useState<Load<DecisionPlace>>({ status: "loading" })
  const [expanded, setExpanded] = useState(false)
  const [around, setAround] = useState<Load<DecisionCellView[]> | null>(null)
  const cellKey = cellIds.join(",")

  useEffect(() => {
    let disposed = false
    loadDecisionPlace(projectId, { fileId, cellIds: cellKey ? cellKey.split(",") : [] }).then(
      (value) => {
        if (!disposed) setPlace({ status: "ready", value })
      },
      () => {
        if (!disposed) setPlace({ status: "error" })
      },
    )
    return () => {
      disposed = true
    }
  }, [projectId, fileId, cellKey])

  function showSurrounding(): void {
    setAround({ status: "loading" })
    loadDecisionSurroundings(projectId, { fileId, cellIds }).then(
      (value) => setAround({ status: "ready", value }),
      () => setAround({ status: "error" }),
    )
  }

  const href = editorCellHref(projectId, fileId, cellIds[0] ?? null, "", cellIds.length > 0)
  const where = place.status === "ready"
    ? [place.value.fileName, place.value.passage].filter(Boolean).join(" · ")
    : null

  return (
    <div data-testid="decision-context" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 font-medium text-foreground">
          {place.status === "loading"
            ? t("autopilot.decisions.context.loading")
            : place.status === "error"
              ? t("autopilot.decisions.context.unavailable")
              : where}
        </span>
        <Link to={href} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
          {t("autopilot.decisions.context.openInEditor")}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      </div>

      {place.status === "ready" && place.value.cells.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 self-start px-2 text-xs"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? t("autopilot.decisions.context.hidePassage")
              : t("autopilot.decisions.context.showPassage", { count: place.value.cells.length })}
          </Button>
          {expanded && (
            <>
              <CellList
                cells={around?.status === "ready" ? around.value : place.value.cells}
              />
              {around === null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 self-start px-2 text-xs"
                  onClick={showSurrounding}
                >
                  {t("autopilot.decisions.context.showSurrounding")}
                </Button>
              )}
              {around?.status === "loading" && (
                <p className="text-xs text-muted-foreground">{t("autopilot.decisions.context.loading")}</p>
              )}
              {around?.status === "error" && (
                <p className="text-xs text-destructive">{t("autopilot.decisions.context.unavailable")}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
