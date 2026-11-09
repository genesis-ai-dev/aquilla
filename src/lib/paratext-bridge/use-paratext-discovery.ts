import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isTauriRuntime } from "../offline/is-tauri"
import { paratextTauri, type Discovery, type DiscoveredProject } from "./tauri"
import { parseParatextSettings, isUtf8Project, booksPresent, bookCodeFromProjectFile, type ParatextSettings } from "./project"
import { parseProjectUserAccess, type ProjectUserAccess } from "./access"
import { BOOK_CODES_BY_NUMBER } from "./book-codes"

export interface BridgeProject {
  path: string
  folderName: string
  settings: ParatextSettings
  guid: string
  utf8: boolean
  access: ProjectUserAccess | null
  /** Book files on disk that belong to this project, with their codes. */
  books: { code: string; fileName: string }[]
}

export function toBridgeProject(p: DiscoveredProject): BridgeProject | null {
  const settings = parseParatextSettings(p.settingsXml)
  if (!settings.guid) return null
  const present = new Set(booksPresent(settings))
  const books = p.bookFiles
    .map((fileName) => ({ fileName, code: bookCodeFromProjectFile(settings, fileName) }))
    .filter((b): b is { fileName: string; code: string } => !!b.code && (present.size === 0 || present.has(b.code)))
    .sort((a, b) => BOOK_CODES_BY_NUMBER.indexOf(a.code) - BOOK_CODES_BY_NUMBER.indexOf(b.code))
  return {
    path: p.path,
    folderName: p.folderName,
    settings,
    guid: settings.guid,
    utf8: isUtf8Project(settings),
    access: p.userAccessXml ? parseProjectUserAccess(p.userAccessXml) : null,
    books,
  }
}

export interface DiscoveryState {
  supported: boolean
  loading: boolean
  error: string | null
  discovery: Discovery | null
  projects: BridgeProject[]
  refresh: () => Promise<void>
  addRoot: (path: string) => Promise<void>
  removeRoot: (path: string) => Promise<void>
}

export interface DiscoveryOptions {
  /** Scan on mount (default). `false` waits for `refresh()`: the "This
   *  computer" workspace asks before reading any Paratext folder. */
  autoStart?: boolean
}

export function useParatextDiscovery({ autoStart = true }: DiscoveryOptions = {}): DiscoveryState {
  const supported = isTauriRuntime()
  const [loading, setLoading] = useState(supported && autoStart)
  const [error, setError] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<Discovery | null>(null)
  // One automatic scan per mount at most: `autoStart` may flip to true after a
  // user-initiated scan succeeded, and that must not scan a second time.
  const started = useRef(false)

  const apply = useCallback(async (run: () => Promise<Discovery>) => {
    started.current = true
    setLoading(true)
    setError(null)
    try {
      setDiscovery(await run())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => apply(paratextTauri.discover), [apply])
  const addRoot = useCallback((path: string) => apply(() => paratextTauri.addRoot(path)), [apply])
  const removeRoot = useCallback((path: string) => apply(() => paratextTauri.removeRoot(path)), [apply])

  // No cancellation flag here on purpose: StrictMode (dev) runs this effect,
  // cleans it up and runs it again, and the second run must not start a second
  // scan, so the `started` guard skips it. A cancel flag set by that cleanup
  // would then throw the only result away and the page would load forever.
  useEffect(() => {
    if (!supported || !autoStart || started.current) return
    started.current = true
    void paratextTauri.discover()
      .then((d) => setDiscovery(d))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [supported, autoStart])

  // Memoised on the discovery result: consumers key effects on a project's
  // identity, so a fresh array per render would re-run them without end.
  const projects = useMemo(
    () => (discovery?.projects ?? [])
      .map(toBridgeProject)
      .filter((p): p is BridgeProject => p !== null)
      .sort((a, b) => a.settings.fullName.localeCompare(b.settings.fullName)),
    [discovery],
  )

  return { supported, loading, error, discovery, projects, refresh, addRoot, removeRoot }
}
