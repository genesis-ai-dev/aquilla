// The toolbar status while the speech model wakes up (useSpeechModelWarmup.ts).
//
// It has to read as "waking up, and this is normal", not as a stuck page: the
// words say what is happening, the seconds count up so the wait is visibly
// moving, and the hint says how long a start usually takes.

import { useEffect, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { TYPICAL_START_MS, type SpeechModelState } from "./useSpeechModelWarmup"

export function SpeechModelBanner({ state }: { state: SpeechModelState }) {
  const t = useT()
  const since = state.kind === "starting" ? state.since : null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  if (state.kind === "hidden") return null
  const typical = TYPICAL_START_MS[state.model]
  const elapsed = since === null ? 0 : Math.max(0, now - since)
  // Never past 95% on time alone: only "ready" fills the bar.
  const percent = since === null ? 100 : Math.min(95, (elapsed / typical) * 100)
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
      role="status"
      aria-busy={since !== null}
      data-testid="transcribe-model-status"
      data-model={state.model}
    >
      {since !== null
        ? <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        : <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />}
      <span className="truncate">
        {since === null
          ? t("transcribe.model.ready")
          : t("transcribe.model.waking", { seconds: Math.floor(elapsed / 1000), typical: Math.round(typical / 1000) })}
      </span>
      <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
