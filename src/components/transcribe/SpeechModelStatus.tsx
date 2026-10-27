// The toolbar status while the speech model starts (useSpeechModelWarmup.ts).

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { TYPICAL_CTC_START_MS, type SpeechModelState } from "./useSpeechModelWarmup"

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
  // Never past 95% on time alone: only "ready" fills the bar.
  const percent = since === null ? 100 : Math.min(95, Math.max(0, ((now - since) / TYPICAL_CTC_START_MS) * 100))
  return (
    <div className="mr-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status" data-testid="transcribe-model-status">
      {since !== null && <Loader2 className="size-3 animate-spin" aria-hidden />}
      <span>{t(since === null ? "transcribe.model.ready" : "transcribe.model.starting")}</span>
      <div className="h-1 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full bg-primary transition-[width] duration-1000" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
