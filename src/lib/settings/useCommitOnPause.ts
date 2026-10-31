/**
 * A typing field that saves as you change it. (AQU-2262)
 *
 * Settings save the moment they change, but a field you type into cannot save
 * on every keystroke: "Ruth (dr" is not a name anyone chose, and "15" on the
 * way to "1500" is not a number anyone meant. So a typing field saves:
 * - after a short pause in typing, when what is there is a whole value;
 * - when you leave it (or press Enter), bringing a number into range;
 * and never otherwise. Escape puts back the value you started from.
 *
 * Everything typed between focusing the field and leaving it is ONE change:
 * a pause writes the value but is not an Undo step of its own; leaving the
 * field ends the change (`final: true`, with where it started in `from`), and
 * that is the one step. While you are not typing in it, the field shows the
 * saved value as it is now, so someone else's change appears in it.
 */
import { useCallback, useEffect, useRef, useState } from "react"

export interface CommitInfo<T> {
  /** The value the field held when this change started. */
  from: T
  /** The change is over (left the field, Enter or Escape): record it. */
  final: boolean
}

export interface CommitOnPauseOptions<T> {
  /** The saved value. */
  value: T
  toText: (value: T) => string
  /** The value typed, or null while it is not a whole value yet. `final` is
   *  set when the person has left the field. */
  parse: (text: string, final: boolean) => T | null
  commit: (next: T, info: CommitInfo<T>) => void
  same?: (a: T, b: T) => boolean
  /** How long a pause in typing saves after (ms). */
  delay?: number
}

export interface CommitOnPauseField {
  value: string
  onChange: (e: { target: { value: string } }) => void
  onBlur: () => void
  onKeyDown: (e: { key: string; preventDefault?: () => void }) => void
}

export const TYPING_PAUSE_MS = 1500

/** parse/toText for a whole number (or decimal, with `step`) in a range. */
export function numberField({ min, max, integer = true }: { min: number; max: number; integer?: boolean }) {
  return {
    toText: (v: number) => String(v),
    parse: (text: string, final: boolean): number | null => {
      if (text.trim() === "") return null
      const n = Number(text)
      if (!Number.isFinite(n)) return null
      const whole = integer ? Math.round(n) : n
      if (final) return Math.min(max, Math.max(min, whole))
      return whole < min || whole > max ? null : whole
    },
  }
}

export function useCommitOnPause<T>({
  value,
  toText,
  parse,
  commit,
  same = Object.is,
  delay = TYPING_PAUSE_MS,
}: CommitOnPauseOptions<T>): CommitOnPauseField {
  // What is typed, while a change is under way; null shows the saved value.
  const [draft, setDraft] = useState<string | null>(null)
  const session = useRef<{ from: T; last: T; text: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The latest callbacks, for a timer or an unmount that outlives a render.
  const live = useRef({ parse, commit, same, value })
  live.current = { parse, commit, same, value }

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  const pause = useCallback(() => {
    timer.current = null
    const s = session.current
    if (!s) return
    const next = live.current.parse(s.text, false)
    if (next === null || live.current.same(next, s.last)) return
    s.last = next
    live.current.commit(next, { from: s.from, final: false })
  }, [])

  const finish = useCallback((revert = false) => {
    clearTimer()
    const s = session.current
    session.current = null
    setDraft(null)
    if (!s) return
    const { parse: p, commit: c, same: eq } = live.current
    const typed = revert ? s.from : p(s.text, true)
    // Not a whole value: the saved one stays, and so does whatever a pause
    // already wrote (it was a whole value, and it is the one on screen).
    const next = typed === null ? s.last : typed
    if (eq(next, s.from) && eq(next, s.last)) return
    c(next, { from: s.from, final: true })
  }, [])

  // Leaving the page while typing still ends the change.
  useEffect(() => () => finish(), [finish])

  return {
    value: draft ?? toText(value),
    onChange: (e) => {
      const text = e.target.value
      if (!session.current) session.current = { from: live.current.value, last: live.current.value, text }
      session.current.text = text
      setDraft(text)
      clearTimer()
      timer.current = setTimeout(pause, delay)
    },
    onBlur: () => finish(),
    onKeyDown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault?.()
        finish()
      } else if (e.key === "Escape" && session.current) {
        e.preventDefault?.()
        finish(true)
      }
    },
  }
}
