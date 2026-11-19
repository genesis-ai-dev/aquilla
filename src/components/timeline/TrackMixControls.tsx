// AQU-2664 (board 74, Sam Nov 19: "good to go"): a timeline track's header
// controls, in Logic's order — the joined M | S pair, a horizontal volume
// fader, and ≈ (Even out) as a real button the same size as M and S.
//
// - M and S are PERSONAL (audibility.ts, kept in this browser per file): M
//   silences the track for you; S plays only the soloed tracks. A track's own M
//   stays as it was while another is soloed.
// - The fader is SHARED and exported (track-volume.ts, `file.track.set`
//   `volumeDb`). It moves the mixer's track gain live, one frame at a time, and
//   writes once when the drag ends; arrow keys write after a 400 ms pause. So a
//   slow device draws and plays smoothly and the outbox sees one write.
// - ≈ opens the Even out window on this track. Grey until the track is evened,
//   blue when it is, amber when some takes couldn't go all the way up.
//
// Sizes and colours are board 74's (`lg_btn`, `lg_fader` in even_out.py); the
// `--lg-*` tokens live in index.css for both themes.

import { EqualApproximately } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type SyntheticEvent } from "react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { clampTrackVolumeDb, faderDb, faderPos, formatFaderDb } from "@/lib/audio/track-volume"

/** One button's box: 20×18, a 1px border, the letter 11px bold. */
const BOX = "inline-flex h-[18px] w-5 shrink-0 items-center justify-center border p-0 text-[11px] leading-none font-bold outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
const OFF = "border-[var(--lg-btn-bd)] bg-[var(--lg-btn)] text-[var(--lg-ink)]"
const LIT = {
  m: "relative z-[2] border-[var(--lg-m)] bg-[var(--lg-m)] text-[var(--lg-m-ink)]",
  s: "relative z-[2] border-[var(--lg-s)] bg-[var(--lg-s)] text-[var(--lg-s-ink)]",
  ev: "border-[var(--lg-ev)] bg-[var(--lg-ev)] text-[var(--lg-ev-ink)]",
  part: "border-[var(--lg-part)] bg-[var(--lg-part)] text-[var(--lg-part-ink)]",
} as const

/** The row is a drag handle and a click target; a control's own press is not. */
const keep = (e: SyntheticEvent) => e.stopPropagation()

export function MuteSoloPair({ name, testKey, muted, soloed, onMute, onSolo, muteOnly = false }: {
  name: string
  /** Names the buttons for tests: `tl-mute-<key>`, `tl-solo-<key>`. */
  testKey: string
  muted: boolean
  soloed: boolean
  onMute(): void
  onSolo(): void
  /** The collapsed gutter strip: M alone. */
  muteOnly?: boolean
}) {
  const t = useT()
  return (
    <span role="group" aria-label={t("editor.mix.group")} className="inline-flex shrink-0">
      <button
        type="button"
        data-testid={`tl-mute-${testKey}`}
        aria-pressed={muted}
        aria-label={t("editor.mix.mute", { name })}
        title={t("editor.mix.muteTitle")}
        onPointerDown={keep}
        onClick={(e) => { keep(e); onMute() }}
        className={cn(BOX, muteOnly ? "rounded-[4px]" : "rounded-l-[4px]", muted ? LIT.m : cn("relative z-[1]", OFF))}
      >
        {t("editor.mix.muteLetter")}
      </button>
      {muteOnly ? null : (
        <button
          type="button"
          data-testid={`tl-solo-${testKey}`}
          aria-pressed={soloed}
          aria-label={t("editor.mix.solo", { name })}
          title={t("editor.mix.soloTitle")}
          onPointerDown={keep}
          onClick={(e) => { keep(e); onSolo() }}
          className={cn(BOX, "-ml-px rounded-r-[4px]", soloed ? LIT.s : cn("relative z-[1]", OFF))}
        >
          {t("editor.mix.soloLetter")}
        </button>
      )}
    </span>
  )
}

export type EvenState = "none" | "full" | "part"

export function EvenOutButton({ testKey, state, onClick }: { testKey: string; state: EvenState; onClick(): void }) {
  const t = useT()
  const label = state === "part" ? t("editor.mix.evenPart") : state === "full" ? t("editor.mix.evenFull") : t("editor.mix.evenOff")
  return (
    <button
      type="button"
      data-testid={`tl-even-${testKey}`}
      data-even={state}
      aria-pressed={state !== "none"}
      aria-label={label}
      title={label}
      onPointerDown={keep}
      onClick={(e) => { keep(e); onClick() }}
      className={cn(BOX, "rounded-[4px]", state === "part" ? LIT.part : state === "full" ? LIT.ev : OFF)}
    >
      <EqualApproximately className="size-[13px]" strokeWidth={2.6} aria-hidden />
    </button>
  )
}

/** The fader is 64px across; its thumb 10px, so it travels 54px. */
const FADER_W = 64
const THUMB_W = 10
const TRAVEL = FADER_W - THUMB_W
/** Arrow keys write this long after the last press. */
const KEY_SAVE_MS = 400

/** "−4.5", "4.5", "+3" or "-3" typed into the field; null when it isn't a number. */
function parseTyped(text: string): number | null {
  const n = Number.parseFloat(text.replace(/[−–]/g, "-").replace(/db/i, "").trim())
  return Number.isFinite(n) ? n : null
}

export function TrackFader({ name, testKey, db, onLive, onCommit, disabled = false }: {
  name: string
  testKey: string
  /** The saved volume, dB. */
  db: number
  /** Every drawn change, for the mixer (no write). */
  onLive(db: number): void
  /** The value to save (once per drag, typed value, Option-click or key pause). */
  onCommit(db: number): void
  /** Not this person's to change: drawn, never moved. */
  disabled?: boolean
}) {
  const t = useT()
  // What was drawn here, and the saved value it was drawn over: a saved value
  // from anywhere (this write coming back, another person, an Undo) takes
  // over from it.
  const [drawn, setDrawn] = useState<{ over: number; v: number } | null>(null)
  const local = drawn && drawn.over === db ? drawn.v : null
  const setLocal = (v: number) => setDrawn({ over: db, v })
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState(false)
  const [typing, setTyping] = useState(false)
  const frame = useRef<number | null>(null)
  const pending = useRef<number | null>(null)
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typedRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current)
    if (keyTimer.current) clearTimeout(keyTimer.current)
  }, [])
  useEffect(() => {
    if (typing) typedRef.current?.select()
  }, [typing])

  const shown = local ?? db
  const x = faderPos(shown) * TRAVEL
  const zero = faderPos(0) * TRAVEL + THUMB_W / 2

  const dbAt = (el: HTMLElement, clientX: number) => {
    const box = el.getBoundingClientRect()
    return clampTrackVolumeDb(faderDb((clientX - box.left - THUMB_W / 2) / TRAVEL))
  }
  const draw = (next: number) => {
    pending.current = next
    if (frame.current != null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const v = pending.current
      if (v == null) return
      setLocal(v)
      onLive(v)
    })
  }
  const commit = (next: number) => {
    const v = clampTrackVolumeDb(next)
    setLocal(v)
    onLive(v)
    onCommit(v)
  }

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    keep(e)
    if (disabled || e.button !== 0) return
    if (e.altKey) {
      commit(0)
      return
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    draw(dbAt(e.currentTarget, e.clientX))
  }
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (dragging) draw(dbAt(e.currentTarget, e.clientX))
  }
  const onPointerUp = (e: PointerEvent<HTMLSpanElement>) => {
    if (!dragging) return
    setDragging(false)
    if (frame.current != null) cancelAnimationFrame(frame.current)
    frame.current = null
    pending.current = null
    commit(dbAt(e.currentTarget, e.clientX))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return
    const step = e.shiftKey ? 3 : 0.5
    let next: number | null = null
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = shown + step
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = shown - step
    else if (e.key === "Home") next = 0
    else if (e.key === "Enter") {
      setTyping(true)
      e.preventDefault()
      return
    }
    if (next == null) return
    e.preventDefault()
    keep(e)
    const v = clampTrackVolumeDb(next)
    setLocal(v)
    onLive(v)
    if (keyTimer.current) clearTimeout(keyTimer.current)
    keyTimer.current = setTimeout(() => {
      keyTimer.current = null
      onCommit(v)
    }, KEY_SAVE_MS)
  }
  // A ref as well as state: Escape unmounts the field, and a blur fired on the
  // way out must not save what Escape threw away.
  const typingRef = useRef(false)
  useEffect(() => { typingRef.current = typing }, [typing])
  const finishTyping = (text: string | null) => {
    if (!typingRef.current) return
    typingRef.current = false
    setTyping(false)
    if (text == null) return
    const n = parseTyped(text)
    if (n != null) commit(n)
  }

  if (typing) {
    return (
      <span className="inline-flex h-[18px] w-16 shrink-0 items-center gap-0.5 rounded-[4px] border border-sky-500 bg-background px-1 font-mono text-[10.5px] text-foreground shadow-[0_0_0_2px_rgba(0,166,244,.20)] dark:border-sky-400 dark:shadow-[0_0_0_2px_rgba(0,188,255,.22)]">
        <input
          ref={typedRef}
          autoFocus
          aria-label={t("editor.mix.fader", { name })}
          defaultValue={(Math.round(shown * 10) / 10).toString().replace("-", "−")}
          onPointerDown={keep}
          onClick={keep}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") finishTyping(e.currentTarget.value)
            else if (e.key === "Escape") finishTyping(null)
          }}
          onBlur={(e) => finishTyping(e.currentTarget.value)}
          className="w-0 min-w-0 flex-1 bg-transparent p-0 outline-none"
        />
        <span aria-hidden className="text-muted-foreground">dB</span>
      </span>
    )
  }

  return (
    <span
      role="slider"
      tabIndex={0}
      data-testid={`tl-fader-${testKey}`}
      aria-label={t("editor.mix.fader", { name })}
      aria-valuemin={-60}
      aria-valuemax={6}
      aria-valuenow={shown}
      aria-valuetext={formatFaderDb(shown)}
      aria-disabled={disabled || undefined}
      title={disabled ? t("editor.mix.faderLocked") : t("editor.mix.faderTitle")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={keep}
      onDoubleClick={(e) => {
        keep(e)
        if (!disabled) setTyping(true)
      }}
      onKeyDown={onKeyDown}
      className={cn(
        "relative h-4 w-16 shrink-0 touch-none rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-sky-500",
        disabled ? "cursor-default opacity-60" : "cursor-ew-resize",
      )}
    >
      {(hover || dragging) && (
        <span
          role="status"
          data-testid={`tl-fader-readout-${testKey}`}
          className="pointer-events-none absolute top-[-1px] right-[calc(100%+6px)] z-30 inline-flex h-[18px] items-center rounded-[4px] border border-foreground/25 bg-popover px-[5px] font-mono text-[10.5px] whitespace-nowrap text-foreground shadow-[0_2px_6px_-2px_rgba(0,0,0,.25)]"
        >
          {formatFaderDb(shown)}
        </span>
      )}
      <span aria-hidden className="absolute inset-x-0 top-[5px] h-1.5 rounded-[3px] bg-[var(--lg-groove)] shadow-[inset_0_1px_1px_rgba(0,0,0,.18)]" />
      <span aria-hidden className="absolute top-[5px] left-0 h-1.5 rounded-[3px] bg-[var(--lg-fill)]" style={{ width: `${(x + THUMB_W / 2).toFixed(1)}px` }} />
      <span aria-hidden className="absolute top-[13px] h-[3px] w-px bg-foreground/50" style={{ left: `${zero.toFixed(1)}px` }} />
      <span
        aria-hidden
        data-testid={`tl-fader-thumb-${testKey}`}
        className={cn(
          "absolute top-0 h-4 w-2.5 rounded-[3px] border border-[var(--lg-thumb-bd)] bg-[var(--lg-thumb)]",
          dragging
            ? "shadow-[0_0_0_2px_rgba(0,166,244,.20),0_1px_2px_rgba(0,0,0,.25)] dark:shadow-[0_0_0_2px_rgba(0,188,255,.22),0_1px_2px_rgba(0,0,0,.25)]"
            : "shadow-[0_1px_2px_rgba(0,0,0,.25)]",
        )}
        style={{ left: `${x.toFixed(1)}px` }}
      >
        <span className="absolute top-[3px] bottom-[3px] left-1 w-px bg-foreground/50" />
      </span>
    </span>
  )
}
