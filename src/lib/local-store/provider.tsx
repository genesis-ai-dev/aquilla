/**
 * Per-project LocalStore lifecycle, scoped to a React subtree.
 *
 *   <LocalStoreProvider projectId={projectId}>
 *     <ProjectWorkspace />
 *   </LocalStoreProvider>
 *
 * Opens an OPFS-backed (or :memory:) SQLite-WASM database scoped to the
 * given project, runs migrations, and tears down on unmount or projectId
 * change. Children read state via `useProjectStore()` (returns the store
 * once ready, null while loading) or `useLocalStoreState()` (full
 * loading/ready/drift/error machine for UI branching).
 *
 * On `MigrationDriftError`, the state lands at `{status: "drift", error}`
 * — the UI is responsible for rendering the wipe-and-reload affordance
 * (see DATA_PERSISTENCE_PLAN.md §13.5 and src/pages/LocalStoreDemo for
 * a reference implementation).
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { LocalStore, MigrationDriftError } from "./db"
import { MIGRATIONS } from "./migrations"

export type LocalStoreState =
  | { status: "loading" }
  | { status: "ready"; store: LocalStore }
  | { status: "drift"; error: MigrationDriftError }
  | { status: "error"; error: Error }

interface LocalStoreContextValue {
  state: LocalStoreState
  projectId: string
}

const LocalStoreContext = createContext<LocalStoreContextValue | null>(null)

export interface LocalStoreProviderProps {
  /**
   * Project identifier — becomes the OPFS file name `codex-{projectId}`.
   * Pass `":memory:"` in tests for an ephemeral store.
   */
  projectId: string
  children: ReactNode
}

export function LocalStoreProvider({
  projectId,
  children,
}: LocalStoreProviderProps) {
  const [state, setState] = useState<LocalStoreState>({ status: "loading" })
  const storeRef = useRef<LocalStore | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: "loading" })
    const dbName = projectId === ":memory:" ? ":memory:" : `codex-${projectId}`
    ;(async () => {
      try {
        const store = await LocalStore.open({ name: dbName })
        await store.migrate(MIGRATIONS)
        if (cancelled) {
          await store.close()
          return
        }
        storeRef.current = store
        setState({ status: "ready", store })
      } catch (e) {
        if (cancelled) return
        if (e instanceof MigrationDriftError) {
          setState({ status: "drift", error: e })
        } else {
          setState({ status: "error", error: e as Error })
        }
      }
    })()
    return () => {
      cancelled = true
      const open = storeRef.current
      storeRef.current = null
      if (open) {
        void open.close()
      }
    }
  }, [projectId])

  return (
    <LocalStoreContext.Provider value={{ state, projectId }}>
      {children}
    </LocalStoreContext.Provider>
  )
}

/**
 * Returns the project's LocalStore once it's open and migrated, or null
 * while the provider is still loading. Throws if called outside a provider.
 */
export function useProjectStore(): LocalStore | null {
  const ctx = useContext(LocalStoreContext)
  if (!ctx) {
    throw new Error(
      "useProjectStore must be called inside a <LocalStoreProvider>",
    )
  }
  return ctx.state.status === "ready" ? ctx.state.store : null
}

/**
 * Full state machine for UI branching: loading / ready / drift / error.
 */
export function useLocalStoreState(): LocalStoreState {
  const ctx = useContext(LocalStoreContext)
  if (!ctx) {
    throw new Error(
      "useLocalStoreState must be called inside a <LocalStoreProvider>",
    )
  }
  return ctx.state
}
