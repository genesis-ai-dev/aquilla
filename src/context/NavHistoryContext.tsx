/**
 * NavHistoryContext — browser-style back/forward plus a separate "previously
 * viewed" list of concrete projects, teams, and editor files (not every
 * org-shell hop).
 *
 * Why not just lean on the browser? The browser keeps a back/forward stack but
 * refuses (for privacy) to expose the labels of those entries, so we can't show
 * a history dropdown from it. This context mirrors the browser's own stack for
 * ←/→ — one entry per real history entry — keyed by React Router's
 * `location.key`. Because we move with `navigate(delta)` (a real history POP),
 * our cursor stays in lock-step with the browser.
 *
 * The clock menu is different: it only records memorable entity visits
 * (a specific project, team, or editor file), capped at 15, newest first.
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
import { deriveNavTitle } from "@/lib/navigation/deriveTitle"
import {
  parseRecentEntity,
  recentProvisionalTitle,
  recentTitleFromNavTitle,
  renameRecentVisit,
  upsertRecentVisit,
  type RecentEntity,
} from "@/lib/navigation/recent-visits"

export interface NavEntry {
  /** React Router location key — stable per real browser-history entry. */
  key: string
  pathname: string
  search: string
  /** Human-readable label shown in tooltips / back-forward nearest. */
  title: string
  /** ms epoch the entry was first visited. */
  timestamp: number
}

export interface NavHistoryValue {
  entries: NavEntry[]
  index: number
  /** Memorable project/team/file visits for the previously-viewed menu (newest first). */
  recent: RecentEntity[]
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
  /** Jump to an absolute index in the browser-synced history stack. */
  go: (targetIndex: number) => void
  /** Open a previously-viewed entity by pathname. */
  openRecent: (pathname: string, search?: string) => void
  /** Upgrade the current entry's label (e.g. once a project name has loaded). */
  setCurrentTitle: (title: string) => void
}

const NavHistoryContext = createContext<NavHistoryValue | null>(null)

// Per-tab persistence so back/forward + recent survive a reload (sessionStorage
// matches the browser's own per-tab history lifetime).
const SESSION_KEY = "aq.navhist.v2"
const MAX_ENTRIES = 100

interface PersistedBlob {
  entries: NavEntry[]
  recent: RecentEntity[]
}

export interface HistoryState {
  entries: NavEntry[]
  index: number
  recent: RecentEntity[]
}

/** A minimal location shape — the bits of React Router's `location` the history
 *  reducer needs. Exported for unit tests. */
export interface NavLoc {
  key: string
  pathname: string
  search: string
}

function loadPersisted(): PersistedBlob {
  if (typeof window === "undefined") return { entries: [], recent: [] }
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (!raw) {
      // Migrate v1 stack-only blob if present.
      const legacy = window.sessionStorage.getItem("aq.navhist.v1")
      if (!legacy) return { entries: [], recent: [] }
      const parsed = JSON.parse(legacy)
      return {
        entries: Array.isArray(parsed) ? (parsed as NavEntry[]) : [],
        recent: [],
      }
    }
    const parsed = JSON.parse(raw) as PersistedBlob
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
    }
  } catch {
    return { entries: [], recent: [] }
  }
}

function persist(entries: NavEntry[], recent: RecentEntity[]): void {
  if (typeof window === "undefined") return
  try {
    const blob: PersistedBlob = {
      entries: entries.slice(-MAX_ENTRIES),
      recent,
    }
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(blob))
  } catch {
    // quota exceeded / storage disabled — non-fatal
  }
}

function makeEntry(loc: { key: string; pathname: string; search: string }): NavEntry {
  return {
    key: loc.key,
    pathname: loc.pathname,
    search: loc.search,
    title: deriveNavTitle(loc.pathname),
    timestamp: Date.now(),
  }
}

function recordRecent(recent: RecentEntity[], loc: NavLoc): RecentEntity[] {
  const entity = parseRecentEntity(loc.pathname)
  if (!entity) return recent
  return upsertRecentVisit(recent, {
    kind: entity.kind,
    id: entity.id,
    pathname: entity.homePath,
    search: "",
    // Provisional until useNavHistoryTitle upgrades with the real name.
    title: recentProvisionalTitle(entity.kind),
  })
}

export function initialState(loc: NavLoc): HistoryState {
  const persisted = loadPersisted()
  // Restore the stack + cursor on a same-tab reload. Match on pathname too, not
  // just key: React Router reuses the sentinel key "default" for the first entry
  // of every fresh load, so a bare key match can land the cursor on a stale
  // entry from a previous session that happens to share that key.
  const i = persisted.entries.findIndex((e) => e.key === loc.key && e.pathname === loc.pathname)
  if (i >= 0) {
    return {
      entries: persisted.entries,
      index: i,
      recent: recordRecent(persisted.recent, loc),
    }
  }
  return {
    entries: [makeEntry(loc)],
    index: 0,
    recent: recordRecent(persisted.recent, loc),
  }
}

export function syncToLocation(
  prev: HistoryState,
  loc: NavLoc,
  navType: "PUSH" | "POP" | "REPLACE",
): HistoryState {
  const withRecent = (next: Omit<HistoryState, "recent">): HistoryState => ({
    ...next,
    recent: recordRecent(prev.recent, loc),
  })

  const existing = prev.entries.findIndex((e) => e.key === loc.key)
  if (existing >= 0) {
    // Back/forward (our buttons, browser chrome, or Alt+Arrow) — move the cursor.
    // Still refresh recent when landing on a memorable entity.
    if (existing === prev.index) {
      const recent = recordRecent(prev.recent, loc)
      return recent === prev.recent ? prev : { ...prev, recent }
    }
    return withRecent({ entries: prev.entries, index: existing })
  }
  if (navType === "REPLACE") {
    // A redirect swaps the current entry without adding a step.
    const entries = prev.entries.slice()
    entries[prev.index] = makeEntry(loc)
    return withRecent({ entries, index: prev.index })
  }
  // A new PUSH — drop any forward entries, append, and point at it.
  const truncated = prev.entries.slice(0, prev.index + 1)
  const nextEntries = [...truncated, makeEntry(loc)].slice(-MAX_ENTRIES)
  return withRecent({ entries: nextEntries, index: nextEntries.length - 1 })
}

export function NavHistoryProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const navType = useNavigationType()

  const [state, setState] = useState<HistoryState>(() => initialState(location))

  // Sync during render (not in an effect) so the stack is already correct before
  // child route effects run — that lets a child's `useNavHistoryTitle` land on
  // the just-created entry instead of racing the location update. Tracking the
  // last-seen key in state (not a ref) is React's canonical "adjust state on
  // prop change during render" pattern.
  const [seenKey, setSeenKey] = useState(location.key)
  if (location.key !== seenKey) {
    setSeenKey(location.key)
    setState((prev) => syncToLocation(prev, location, navType))
  }

  useEffect(() => {
    persist(state.entries, state.recent)
  }, [state.entries, state.recent])

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

  const openRecent = useCallback(
    (pathname: string, search = "") => {
      navigate({ pathname, search })
    },
    [navigate],
  )

  const setCurrentTitle = useCallback((title: string) => {
    const next = title.trim()
    if (!next) return
    setState((prev) => {
      const cur = prev.entries[prev.index]
      let entries = prev.entries
      let index = prev.index
      if (cur && cur.title !== next) {
        entries = prev.entries.slice()
        entries[prev.index] = { ...cur, title: next }
      }

      // Prefer the entity name alone in recently viewed (drop " · Editor" etc.;
      // for files keep the file name after " · ").
      const entity = cur ? parseRecentEntity(cur.pathname) : null
      const recent = entity
        ? renameRecentVisit(
            prev.recent,
            entity.kind,
            entity.id,
            recentTitleFromNavTitle(entity.kind, next),
          )
        : prev.recent

      if (entries === prev.entries && recent === prev.recent) return prev
      return { entries, index, recent }
    })
  }, [])

  const value: NavHistoryValue = {
    entries: state.entries,
    index: state.index,
    recent: state.recent,
    canGoBack: state.index > 0,
    canGoForward: state.index < state.entries.length - 1,
    goBack,
    goForward,
    go,
    openRecent,
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
