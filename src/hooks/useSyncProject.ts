import { useState, useCallback, useEffect } from "react"
import { syncProject, type SyncPhase, type SyncResult } from "@/lib/sync/git-sync"
import { useSyncing } from "@/context/SyncingContext"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"

interface State {
  phase: SyncPhase
  inFlight: boolean
  lastResult: SyncResult | null
}

export function useSyncProject() {
  const [state, setState] = useState<State>({ phase: "idle", inFlight: false, lastResult: null })
  const { setSyncing } = useSyncing()

  useEffect(() => { setSyncing(state.inFlight) }, [state.inFlight, setSyncing])

  const sync = useCallback(
    async (project: ProjectRecord, session: FrontierSession): Promise<SyncResult | null> => {
      let alreadyInFlight = false
      setState((s) => {
        if (s.inFlight) {
          alreadyInFlight = true
          return s
        }
        return { ...s, inFlight: true, phase: "checking-dirty" }
      })
      if (alreadyInFlight) return null

      const result = await syncProject(project, session, {
        onPhase: (phase) => setState((s) => ({ ...s, phase })),
      })
      setState({
        phase:
          result.status === "synced" || result.status === "merged"
            ? "done"
            : result.status === "no-changes"
              ? "idle"
              : result.status === "remote-moved"
                ? "remote-moved"
                : "error",
        inFlight: false,
        lastResult: result,
      })
      return result
    },
    [],
  )

  return { ...state, sync }
}
