/**
 * The quiet "Saved" beside a setting. (AQU-2262)
 *
 * Settings save the moment they change, so there is no Save bar to say what
 * happened. Each setting says it itself, in one short line beside its control:
 * "Saving…" while a slow write is out, "Saved" for a moment once it lands, or
 * — and this one stays until the setting is changed again — why it did not:
 * someone else changed it first and their change is kept, or the write failed.
 *
 * A page wraps its settings in a SaveStatusProvider; a change runs through
 * `useSaveTracker()`, keyed by the setting's id; `<SaveStatus id>` (or a
 * SettingsRow's `saveId`) shows it. Outside a provider nothing shows, so a
 * section shared with another page is unaffected.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { Check } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/** How a change ended. `none`: nothing to say (no change was made). */
export type SaveResult =
  | { kind: "saved" }
  | { kind: "none" }
  | { kind: "theirs"; name: string | null }
  | { kind: "failed"; message: string }

type SaveState = { kind: "saving"; since: number } | Exclude<SaveResult, { kind: "none" }>

/** How long "Saved" stays (ms). */
export const SAVED_VISIBLE_MS = 2500
/** A write quicker than this never says "Saving…" (ms). */
const SAVING_SHOWN_AFTER_MS = 400

class SaveStatusStore {
  private states = new Map<string, SaveState>()
  private runs = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  get = (id: string): SaveState | undefined => this.states.get(id)

  private set(id: string, state: SaveState | undefined) {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
    if (state) this.states.set(id, state)
    else this.states.delete(id)
    if (state?.kind === "saved") {
      this.timers.set(id, setTimeout(() => this.set(id, undefined), SAVED_VISIBLE_MS))
    }
    for (const fn of this.listeners) fn()
  }

  async track(id: string, run: () => Promise<SaveResult>): Promise<SaveResult> {
    const mine = (this.runs.get(id) ?? 0) + 1
    this.runs.set(id, mine)
    this.set(id, { kind: "saving", since: Date.now() })
    let result: SaveResult
    try {
      result = await run()
    } catch (err) {
      result = { kind: "failed", message: err instanceof Error ? err.message : String(err) }
    }
    // A newer change to the same setting speaks for it now.
    if (this.runs.get(id) === mine) this.set(id, result.kind === "none" ? undefined : result)
    return result
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}

const StoreContext = createContext<SaveStatusStore | null>(null)

export function SaveStatusProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SaveStatusStore())
  useEffect(() => () => store.dispose(), [store])
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

/** Run a change to a setting and show how it went beside it. */
export function useSaveTracker(): (id: string, run: () => Promise<SaveResult>) => Promise<SaveResult> {
  const store = useContext(StoreContext)
  return (id, run) => (store ? store.track(id, run) : run())
}

const noStore = () => () => {}
const nothing = () => undefined

export function SaveStatus({ id, className }: { id: string; className?: string }) {
  const t = useT()
  const store = useContext(StoreContext)
  const state = useSyncExternalStore(
    store?.subscribe ?? noStore,
    () => store?.get(id),
    nothing,
  )
  // "Saving…" only for a write that takes a moment.
  const [, tick] = useState(0)
  useEffect(() => {
    if (state?.kind !== "saving") return
    const wait = SAVING_SHOWN_AFTER_MS - (Date.now() - state.since)
    if (wait <= 0) return
    const timer = setTimeout(() => tick((n) => n + 1), wait)
    return () => clearTimeout(timer)
  }, [state])
  if (!store) return null
  const text =
    !state ? null
    : state.kind === "saving" ? (Date.now() - state.since >= SAVING_SHOWN_AFTER_MS ? t("settings.save.saving") : null)
    : state.kind === "saved" ? t("settings.save.saved")
    : state.kind === "theirs"
      ? state.name ? t("settings.save.theirsKept", { name: state.name }) : t("settings.save.theirsKeptNoName")
      : state.message
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid={`save-status-${id}`}
      className={cn(
        "inline-flex min-h-4 items-center gap-1 text-xs",
        state?.kind === "failed" ? "text-destructive"
          : state?.kind === "theirs" ? "text-amber-700 dark:text-amber-400"
          : "text-muted-foreground",
        className,
      )}
    >
      {state?.kind === "saved" ? <Check className="size-3" aria-hidden /> : null}
      {text}
    </span>
  )
}
