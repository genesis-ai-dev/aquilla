/**
 * NavHistoryContext — a small, client-side back/forward history with a cursor,
 * stored as human-readable entries.
 *
 * Why not just lean on the browser? The browser keeps a back/forward stack but
 * refuses (for privacy) to expose the labels of those entries, so we can't show
 * a "hold to see history" popover from it. This context mirrors the browser's
 * own stack — one entry per real history entry — keyed by React Router's
 * `location.key`. Because we move with `navigate(delta)` (a real history POP),
 * our cursor stays in lock-step with the browser, so native back/forward, the
 * Alt+Arrow shortcuts, and trackpad swipes all update our cursor too.
 *
 * Access control: entries are just URLs the user actually visited. Visiting a
 * route already passes whatever on-load access checks that route enforces, and
 * the API rejects unauthorized actions regardless — so replaying a URL the user
 * reached is inherently user-determined.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useLocation, useNavigate, useNavigationType } from "react-router-dom"
import { deriveNavTitle, deriveNavTitleKey } from "@/lib/navigation/deriveTitle"
import { useT } from "@/lib/i18n/I18nProvider"

export interface NavEntry {
  /** React Router location key — stable per real browser-history entry. */
  key: string
  pathname: string
  search: string
  /** Human-readable label shown in the history popover. */
  title: string
  /** ms epoch the entry was first visited. */
  timestamp: number
}

export interface NavHistoryValue {
  entries: NavEntry[]
  index: number
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
  /** Jump to an absolute index in the history stack. */
  go: (targetIndex: number) => void
  /** Upgrade the current entry's label (e.g. once a project name has loaded). */
  setCurrentTitle: (title: string) => void
}

const NavHistoryContext = createContext<NavHistoryValue | null>(null)

// Per-tab persistence so back/forward survive a reload (sessionStorage matches
// the browser's own per-tab history lifetime). Capped to keep the blob small.
const SESSION_KEY = "aq.navhist.v1"
const MAX_ENTRIES = 100

export interface HistoryState {
  entries: NavEntry[]
  index: number
}

/** A minimal location shape — the bits of React Router's `location` the history
 *  reducer needs. Exported for unit tests. */
export interface NavLoc {
  key: string
  pathname: string
  search: string
}

function loadPersisted(): NavEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as NavEntry[]) : []
  } catch {
    return []
  }
}

function persist(entries: NavEntry[]): void {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
  } catch {
    // quota exceeded / storage disabled — non-fatal, history just won't persist
  }
}

/**
 * Resolves a pathname to a display title. `src/lib/navigation/deriveTitle.ts`
 * can't call `useT()` (it's pure, locale-free lib code), so the component
 * below builds a resolver from `useT()` + `deriveNavTitleKey` and passes it
 * in; `initialState`/`syncToLocation` default to the English-only
 * `deriveNavTitle` so callers without a live locale (tests, and any future
 * caller that doesn't have one) keep working unchanged.
 */
export type TitleResolver = (pathname: string) => string

function makeEntry(
  loc: { key: string; pathname: string; search: string },
  resolveTitle: TitleResolver = deriveNavTitle,
): NavEntry {
  return {
    key: loc.key,
    pathname: loc.pathname,
    search: loc.search,
    title: resolveTitle(loc.pathname),
    timestamp: Date.now(),
  }
}

export function initialState(loc: NavLoc, resolveTitle: TitleResolver = deriveNavTitle): HistoryState {
  const persisted = loadPersisted()
  // Restore the stack + cursor on a same-tab reload. Match on pathname too, not
  // just key: React Router reuses the sentinel key "default" for the first entry
  // of every fresh load, so a bare key match can land the cursor on a stale
  // entry from a previous session that happens to share that key.
  const i = persisted.findIndex((e) => e.key === loc.key && e.pathname === loc.pathname)
  if (i >= 0) return { entries: persisted, index: i }
  return { entries: [makeEntry(loc, resolveTitle)], index: 0 }
}

export function syncToLocation(
  prev: HistoryState,
  loc: NavLoc,
  navType: "PUSH" | "POP" | "REPLACE",
  resolveTitle: TitleResolver = deriveNavTitle,
): HistoryState {
  const existing = prev.entries.findIndex((e) => e.key === loc.key)
  if (existing >= 0) {
    // Back/forward (our buttons, browser chrome, or Alt+Arrow) — move the cursor.
    return existing === prev.index ? prev : { entries: prev.entries, index: existing }
  }
  if (navType === "REPLACE") {
    // A redirect (e.g. a route that bounces to a remembered location) swaps the
    // current entry without adding a step — update it in place and keep the
    // surrounding back/forward stack intact.
    const entries = prev.entries.slice()
    entries[prev.index] = makeEntry(loc, resolveTitle)
    return { entries, index: prev.index }
  }
  // A new PUSH — drop any forward entries, append, and point at it.
  const truncated = prev.entries.slice(0, prev.index + 1)
  const nextEntries = [...truncated, makeEntry(loc, resolveTitle)].slice(-MAX_ENTRIES)
  return { entries: nextEntries, index: nextEntries.length - 1 }
}

export function NavHistoryProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const navType = useNavigationType()
  const t = useT()

  // Resolves through the active locale where deriveNavTitleKey has a real
  // catalog key; `raw` entries (an arbitrary URL segment, or a title read
  // from a still-unkeyed English source) pass through unchanged either way.
  const resolveTitle = useCallback<TitleResolver>(
    (pathname) => {
      const info = deriveNavTitleKey(pathname)
      return info.kind === "key" ? t(info.key) : info.text
    },
    [t],
  )

  const [state, setState] = useState<HistoryState>(() => initialState(location, resolveTitle))

  // Sync during render (not in an effect) so the stack is already correct before
  // child route effects run — that lets a child's `useNavHistoryTitle` land on
  // the just-created entry instead of racing the location update. Tracking the
  // last-seen key in state (not a ref) is React's canonical "adjust state on
  // prop change during render" pattern.
  const [seenKey, setSeenKey] = useState(location.key)
  if (location.key !== seenKey) {
    setSeenKey(location.key)
    setState((prev) => syncToLocation(prev, location, navType, resolveTitle))
  }

  useEffect(() => {
    persist(state.entries)
  }, [state.entries])

  // Read-through ref so the nav callbacks can stay referentially stable while
  // still seeing the latest committed state (updated post-commit via effect).
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const go = useCallback(
    (targetIndex: number) => {
      const { entries, index } = stateRef.current
      if (targetIndex < 0 || targetIndex >= entries.length || targetIndex === index) return
      navigate(targetIndex - index)
    },
    [navigate],
  )
  const goBack = useCallback(() => go(stateRef.current.index - 1), [go])
  const goForward = useCallback(() => go(stateRef.current.index + 1), [go])

  const setCurrentTitle = useCallback((title: string) => {
    const next = title.trim()
    if (!next) return
    setState((prev) => {
      const cur = prev.entries[prev.index]
      if (!cur || cur.title === next) return prev
      const entries = prev.entries.slice()
      entries[prev.index] = { ...cur, title: next }
      return { entries, index: prev.index }
    })
  }, [])

  const value: NavHistoryValue = {
    entries: state.entries,
    index: state.index,
    canGoBack: state.index > 0,
    canGoForward: state.index < state.entries.length - 1,
    goBack,
    goForward,
    go,
    setCurrentTitle,
  }

  return <NavHistoryContext.Provider value={value}>{children}</NavHistoryContext.Provider>
}

/** Returns the nav history, or null when rendered outside the provider
 *  (e.g. in component tests that mount a page without the app root). */
export function useNavHistory(): NavHistoryValue | null {
  return useContext(NavHistoryContext)
}

/** Upgrade the current history entry's label once a richer name is known.
 *  No-op outside the provider. */
export function useNavHistoryTitle(title: string | null | undefined): void {
  const ctx = useContext(NavHistoryContext)
  const setTitle = ctx?.setCurrentTitle
  const location = useLocation()
  useEffect(() => {
    if (setTitle && title) setTitle(title)
    // Re-run on navigation so the label lands on the now-current entry.
  }, [setTitle, title, location.key])
}
