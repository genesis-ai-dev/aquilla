// AQU-2664 (board 71, Sam Nov 19: "good to go"): the ONE Even out window. The
// file's ⋯ menu, a track header's ≈ and the track menu all open it; it starts
// on the scope it was opened from — the whole file, one track, or the selected
// tracks (offered only while two or more are selected).
//
// NON-MODAL, with no dimmer: the editor stays usable while it is open and
// while it runs. Measuring happens off the page (the loudness worker, or the
// page meter in yielding chunks), so the window only shows the count. Cancel
// stops measuring and keeps what is done; closing it while it runs lets the
// run finish. When some takes could not be measured on this device, the window
// stays open and says how many were skipped (the weak-hardware fallback).
//
// Board 71's window(): 440px, padding 20, gap 12; the title, the line under
// it, the scope radios, the target box with its click (i), and the footer.

import { LoaderCircle, RotateCcw } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { InfoReveal, InfoToggle } from "@/components/ui/info-tip"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { ClearResult, EvenOutOptions, EvenOutResult, TakeRef } from "@/lib/audio/even-out"
import type { EvenOutPick, EvenOutScope } from "@/lib/audio/even-out-scopes"
import { DEFAULT_EVEN_TARGET_LUFS } from "@/lib/audio/take-gain"

export interface EvenOutDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  scopes: readonly EvenOutScope[]
  start: EvenOutPick
  targetLufs?: number
  run(takes: readonly TakeRef[], opts: Pick<EvenOutOptions, "signal" | "onProgress" | "onWaiting">): Promise<EvenOutResult | null>
  clear(takes: readonly TakeRef[]): Promise<ClearResult | null>
  /** The run ended (done or cancelled): the workspace shows its toast. */
  onRan(result: EvenOutResult, scope: EvenOutScope): void
  onCleared(result: ClearResult, scope: EvenOutScope): void
}

/** "−16" with a real minus. */
const lufsText = (v: number) => (v < 0 ? `−${Math.abs(v)}` : `${v}`)

export function EvenOutDialog({ open, onOpenChange, scopes, start, targetLufs = DEFAULT_EVEN_TARGET_LUFS, run, clear, onRan, onCleared }: EvenOutDialogProps) {
  const t = useT()
  const [pick, setPick] = useState<EvenOutPick>(start)
  const [infoOpen, setInfoOpen] = useState(false)
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  // A fresh window each time it opens, on the scope it was opened from
  // (adjusted while rendering, not in an effect).
  const [shownFor, setShownFor] = useState<{ open: boolean; start: EvenOutPick }>({ open, start })
  if (shownFor.open !== open || shownFor.start !== start) {
    setShownFor({ open, start })
    if (open) {
      setPick(start)
      setNote(null)
      setInfoOpen(false)
    }
  }

  const scope = scopes.find((s) => s.pick === pick) ?? scopes[0]
  const n = scope?.takes.length ?? 0

  const subFor = (s: EvenOutScope) => {
    const takes = t("editor.evenOut.takeCount", { count: s.takes.length })
    if (s.pick === "file") return `${t("editor.evenOut.trackCount", { count: s.trackCount })} · ${takes}`
    if (s.pick === "sel") return `${s.names.join(", ")} · ${takes}`
    return takes
  }
  const labelFor = (s: EvenOutScope) =>
    s.pick === "file" ? t("editor.evenOut.wholeFile") : s.pick === "sel" ? t("editor.evenOut.selectedTracks", { count: s.trackCount }) : s.names[0]

  const go = async () => {
    if (!scope || running) return
    const ac = new AbortController()
    abort.current = ac
    setNote(null)
    setRunning({ done: 0, total: n })
    const r: EvenOutResult | null = await run(scope.takes, {
      signal: ac.signal,
      // Takes that already have a reading count as done: they are not
      // measured again (board 71G).
      onProgress: (done, toMeasure) => {
        setNote(null)
        setRunning({ done: n - toMeasure + done, total: n })
      },
      // Review M2: one Even out at a time; this one waits its turn.
      onWaiting: () => setNote(t("editor.evenOut.waiting")),
    }).catch(() => null)
    abort.current = null
    setRunning(null)
    if (!r) {
      setNote(t("editor.evenOut.failed"))
      return
    }
    if (r.notAllowed) {
      setNote(t("editor.evenOut.notAllowed"))
      return
    }
    onRan(r, scope)
    if (r.unmeasured > 0) setNote(t("editor.evenOut.skipped", { count: r.unmeasured }))
    else onOpenChange(false)
  }

  const doClear = async () => {
    if (!scope || running || scope.evened.length === 0) return
    const r = await clear(scope.evened)
    if (!r) {
      setNote(t("editor.evenOut.failed"))
      return
    }
    if (r.notAllowed) {
      setNote(t("editor.evenOut.notAllowed"))
      return
    }
    onCleared(r, scope)
    onOpenChange(false)
  }

  const pct = running && running.total > 0 ? Math.round((running.done / running.total) * 100) : 0
  const finished = note != null && !running

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false} disablePointerDismissal>
      <DialogContent
        overlay={false}
        data-testid="even-out-window"
        className="w-[440px] max-w-[calc(100%-2rem)] gap-3 rounded-md p-5 shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_10%,transparent),0_18px_40px_-10px_rgba(0,0,0,.35)] sm:max-w-[440px]"
      >
        <DialogTitle className="text-base font-medium">{t("editor.evenOut.title")}</DialogTitle>
        <DialogDescription className="m-0 text-sm leading-normal text-muted-foreground">{t("editor.evenOut.description")}</DialogDescription>
        <RadioGroup
          aria-label={t("editor.evenOut.scope")}
          value={pick}
          onValueChange={(v) => setPick(v as EvenOutPick)}
          disabled={running != null}
          className="gap-0.5"
        >
          {scopes.map((s) => (
            <label key={s.pick} className="flex cursor-pointer items-start gap-2.5 px-1 py-1.5 text-foreground">
              <RadioGroupItem value={s.pick} className="mt-0.5 shrink-0" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span dir="auto" className="text-sm font-medium">{labelFor(s)}</span>
                <span dir="auto" className="text-[13px] text-muted-foreground">{subFor(s)}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <div className="flex flex-col rounded-md bg-muted px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-[13px] text-foreground">
            <span>{t("editor.evenOut.targetLead")}</span>
            <b className="font-semibold">{t("editor.evenOut.targetValue", { lufs: lufsText(targetLufs) })}</b>
            <InfoToggle
              open={infoOpen}
              onToggle={() => setInfoOpen((o) => !o)}
              label={t("editor.evenOut.targetInfoLabel")}
              controls="even-out-target-info"
            />
          </span>
          <InfoReveal open={infoOpen} id="even-out-target-info" testId="even-out-target-info">
            <span className="block max-w-[380px] pt-0.5 text-[12.5px] leading-[1.45] text-muted-foreground">{t("editor.evenOut.targetInfo")}</span>
          </InfoReveal>
        </div>
        {note ? (
          <p role="status" data-testid="even-out-note" className="m-0 text-[13px] leading-normal text-foreground/80">{note}</p>
        ) : null}
        {running ? (
          <>
            <div className="flex items-center gap-2.5">
              <LoaderCircle aria-hidden className="size-[15px] shrink-0 animate-spin text-sky-700 dark:text-sky-300" />
              <span role="status" className="flex-1 text-[13.5px] text-foreground/80">
                {t("editor.evenOut.measuring", { done: running.done, count: running.total })}
              </span>
              <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                {t("common.cancel")}
              </Button>
            </div>
            <span className="block h-1 overflow-hidden rounded-[2px] bg-muted">
              <span data-testid="even-out-progress" className="block h-1 bg-sky-500 transition-[width] duration-200 dark:bg-sky-400" style={{ width: `${pct}%` }} />
            </span>
          </>
        ) : finished ? (
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" data-testid="even-out-close" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {scope && scope.evened.length > 0 ? (
              <Button type="button" variant="ghost" className="px-1.5 text-foreground/80" onClick={() => void doClear()}>
                <RotateCcw aria-hidden className="size-3.5" />
                {t("editor.evenOut.clear", { count: scope.evened.length })}
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={n === 0} onClick={() => void go()} className={cn(n === 0 && "opacity-50")}>
              {t("editor.evenOut.run", { count: n })}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
