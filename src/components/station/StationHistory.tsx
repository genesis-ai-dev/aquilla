// The Station's History (AQU-2327, spec items 2 and 30): the ⋯ menu's item,
// and the box it opens under the transport.

import { useEffect, useMemo, useState } from "react"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import type { EditOp } from "@/lib/station/edit-list"
import { draftRows, historyRowsFromEvents, historyWhen, type HistoryRow } from "@/lib/station/history-rows"
import { STATION_PICKS } from "@/lib/station/picks"
import { setStationUi, useStationUi } from "@/lib/station/ui"
import { fetchCellHistory } from "@/lib/sync/history-read"
import type { StationHost, StationTake } from "./station-host"

/** Item 2: the Station's own items in its area's ⋯ menu. */
export function StationMenuItems() {
  const t = useT()
  const ui = useStationUi()
  return (
    <>
      {ui.removeNoise ? (
        <DropdownMenuItem onClick={ui.removeNoise} data-testid="station-menu-noise">
          <span className="flex min-w-0 flex-col">
            <span>{t("editor.station.removeNoise")}</span>
            <span className="text-[11px] text-muted-foreground/70">{t("editor.station.makesVersion")}</span>
          </span>
        </DropdownMenuItem>
      ) : null}
      {ui.changeVoice ? (
        <DropdownMenuItem onClick={ui.changeVoice} data-testid="station-menu-voice">
          <span className="flex min-w-0 flex-col">
            <span>{t("editor.station.changeVoice")}</span>
            <span className="text-[11px] text-muted-foreground/70">{t("editor.station.makesVersion")}</span>
          </span>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={() => setStationUi({ historyOpen: !ui.historyOpen })} data-testid="station-menu-history">
        <span className="flex min-w-0 flex-col">
          <span>{ui.historyOpen ? t("editor.station.hideHistory") : t("editor.station.history")}</span>
          <span className="text-[11px] text-muted-foreground/70">
            {ui.historyCount > 0 ? t("editor.station.historyEntries", { count: ui.historyCount }) : t("editor.station.historyNothing")}
          </span>
        </span>
      </DropdownMenuItem>
    </>
  )
}

/** The take and the versions it was made from, oldest last. */
export function versionChain(take: StationTake, audioId: string): string[] {
  const atts = take.cell.attachments ?? {}
  const out = [audioId]
  let ref = take.att.referenceAudioId
  while (ref && !out.includes(ref)) {
    out.push(ref)
    ref = atts[ref]?.referenceAudioId
  }
  return out
}

/** A version's kinds of change, in the notice's own words (item 8). */
const KIND_KEY = {
  deleted: "editor.station.kindDeleted",
  inserted: "editor.station.kindInserted",
  noise: "editor.station.kindNoise",
} as const

/** Item 30. Loads the line's history while open; counts it for the ⋯ item. */
export function StationHistory({
  host,
  take,
  cellId,
  audioId,
  ops,
  durationSec,
  refreshKey,
}: {
  host: StationHost
  take: StationTake
  cellId: string
  audioId: string
  ops: readonly EditOp[]
  durationSec: number | null
  /** Changes when the take changes, so the box re-reads. */
  refreshKey: string
}) {
  const t = useT()
  const { locale } = useI18n()
  const ui = useStationUi()
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const chain = useMemo(() => versionChain(take, audioId), [take, audioId])
  const projectId = host.project.id
  const { fileId } = take
  const getSyncToken = host.getSyncToken
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const jwt = await getSyncToken(projectId, fileId)
        if (!jwt) throw new Error("no token")
        const events = await fetchCellHistory(projectId, fileId, cellId, jwt, { limit: 200 })
        const ids = new Set(chain)
        const depth = (id: string) => chain.length - chain.indexOf(id)
        // Each version's own length, for a trim that ran to its edge.
        const durationOf = (id: string) => {
          if (id === audioId) return durationSec
          const ms = take.cell.attachments?.[id]?.durationMs
          return ms != null ? ms / 1000 : null
        }
        // Item 30: a version's changes in the notice's words, its lines by name.
        const wording = {
          kinds: (kinds: readonly string[]) =>
            kinds
              .filter((k): k is keyof typeof KIND_KEY => k in KIND_KEY)
              .map((k) => t(KIND_KEY[k]))
              .join(", "),
          lines: (cellIds: readonly string[]) => cellIds.map((id) => host.lineName(id)).filter(Boolean).join(", "),
        }
        if (live) {
          setRows(historyRowsFromEvents(events, ids, { durationSec, durationOf, versionOf: depth, wording }))
          setFailed(false)
        }
      } catch {
        if (live) setFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [projectId, fileId, cellId, chain, durationSec, getSyncToken, refreshKey, audioId, take, t, host])

  const all = useMemo(() => [...(rows ?? []), ...draftRows(ops)], [rows, ops])
  useEffect(() => {
    setStationUi({ historyCount: all.length })
  }, [all.length])

  if (!ui.historyOpen) return null
  const text = (r: HistoryRow) => {
    const row = t(r.key as never, r.params as never)
    return STATION_PICKS.historyNamesWho && r.who && r.at
      ? t("editor.station.historyWho", { row, who: r.who, when: historyWhen(r.at, locale) })
      : row
  }
  return (
    <div data-testid="station-history" className="mx-3 mb-1.5 flex shrink-0 flex-col gap-0.5 rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <span className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">{t("editor.station.historyTitle")}</span>
      {failed && rows == null ? <span className="text-[11.5px] text-muted-foreground">{t("editor.station.historyFailed")}</span> : null}
      {all.map((r, i) => (
        <span key={i} className="text-[11.5px] text-muted-foreground">
          {text(r)}
        </span>
      ))}
      <span className="text-[11.5px] text-muted-foreground/70">{t("editor.station.historyFootnote")}</span>
    </div>
  )
}
