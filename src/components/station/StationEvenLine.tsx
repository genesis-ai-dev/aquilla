// AQU-2664 (boards 72, 73): the Station's one evening-out line, under the
// transport — "≈ Evened +10.2 dB · your volume −2 dB · Clear". Evening out
// comes before the take's own volume, so "your volume" reads from the evened
// level (0 dB = as evened). Amber when the take couldn't go all the way.
//
// Clear takes off only the evening out (its own volume and fades stay), as one
// Undo step with its toast; the line then stays — "Not evened · your volume
// −2 dB · Even out again" — so it can be evened again. A take that was never
// evened while open here shows no line.

import { EqualApproximately } from "lucide-react"
import { useState } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { takeGain } from "@/lib/audio/take-gain"
import { formatFaderDb, formatOwnVolume } from "@/lib/audio/track-volume"
import type { StationHost, StationTake } from "./station-host"

export function StationEvenLine({ host, take, target, ownDb, editable }: {
  host: StationHost
  take: StationTake
  target: { cellId: string; audioId: string }
  /** The take's own volume as the volume line shows it, dB. */
  ownDb: number
  /** May this person change the take (Clear, Even out again)? */
  editable: boolean
}) {
  const t = useT()
  const g = takeGain(take.att)
  const evened = g.evened && g.measured
  // Once evened while open here, the line stays (so a Clear can be undone by
  // evening out again); a different take starts afresh.
  const key = `${target.cellId}\u0000${target.audioId}`
  const [seenFor, setSeenFor] = useState<string | null>(evened ? key : null)
  // Adjusted while rendering: this take was evened while open here.
  if (evened && seenFor !== key) setSeenFor(key)
  const [busy, setBusy] = useState(false)
  if (!evened && seenFor !== key) return null

  const ref = { cellId: target.cellId, audioId: target.audioId }
  const volume = formatOwnVolume(ownDb)
  const clear = async () => {
    setBusy(true)
    try {
      if (host.clearEvenOutTake) {
        await host.clearEvenOutTake(target.cellId, target.audioId, {
          take: take.att.label ?? t("audio.takesStrip.takeFallback"),
          line: host.lineName(target.cellId),
          volume,
        })
      } else await host.clearEvenOut?.([ref])
    } finally {
      setBusy(false)
    }
  }
  const again = async () => {
    setBusy(true)
    try {
      await host.evenOut?.([ref])
    } finally {
      setBusy(false)
    }
  }
  const dot = <span aria-hidden className="text-muted-foreground">·</span>
  const link = "cursor-pointer text-sky-700 underline underline-offset-2 hover:text-sky-800 disabled:cursor-default disabled:opacity-50 dark:text-sky-300"

  return (
    <div data-testid="station-even-line" className="flex min-h-[30px] shrink-0 flex-wrap items-center gap-1.5 px-3 pb-2 text-xs">
      {evened ? (
        <span
          data-testid="station-even-amount"
          className={cn(
            "inline-flex items-center gap-[5px] font-semibold",
            g.held ? "text-amber-700 dark:text-amber-400" : "text-sky-700 dark:text-sky-300",
          )}
        >
          <EqualApproximately aria-hidden className="size-3.5" strokeWidth={2.4} />
          {g.held
            ? t("editor.station.evenedPart", { db: formatFaderDb(g.correctionDb) })
            : t("editor.station.evened", { db: formatFaderDb(g.correctionDb) })}
        </span>
      ) : (
        <span data-testid="station-even-amount" className="inline-flex items-center gap-[5px] text-muted-foreground">
          <EqualApproximately aria-hidden className="size-3.5" strokeWidth={2.4} />
          {t("editor.station.notEvened")}
        </span>
      )}
      {dot}
      <span className="text-foreground/80">{t("editor.station.yourVolume", { db: volume })}</span>
      {editable && (evened ? host.clearEvenOut || host.clearEvenOutTake : host.evenOut) ? (
        <>
          {dot}
          <button type="button" disabled={busy} className={link} onClick={() => void (evened ? clear() : again())}>
            {evened ? t("editor.station.evenClear") : t("editor.station.evenAgain")}
          </button>
        </>
      ) : null}
    </div>
  )
}
