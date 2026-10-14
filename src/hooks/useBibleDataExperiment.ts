// The Bible data experiment for a project on this device (AQU-1685), for
// surfaces that have a project id but not the project record: autopilot's
// panels, drawn on the overview, in the run pill and in the workbench.
//
// The switch is device-local, so it lives on this device's IndexedDB record of
// the project. Re-read whenever that record changes, so turning the switch in
// Project settings shows or hides Bible data here without a reload. Off until
// the read lands, and off for a project this device has no record of.

import { useEffect, useState } from "react"
import { getProject, subscribeProjectRecords } from "@/lib/store/project-index"
import { isBibleDataExperimentOn } from "@/lib/bible-data/experiment"

export function useBibleDataExperiment(projectId: string): boolean {
  const [state, setState] = useState<{ projectId: string; on: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    let latestRead = 0
    const read = () => {
      // Last-issued read wins, as in useProject: a slow older read must not
      // bring back a value the user just switched away from.
      const id = ++latestRead
      void getProject(projectId)
        .then((local) => {
          if (!cancelled && id === latestRead) setState({ projectId, on: isBibleDataExperimentOn(local) })
        })
        .catch(() => {
          if (!cancelled && id === latestRead) setState({ projectId, on: false })
        })
    }
    read()
    const unsubscribe = subscribeProjectRecords((changedId) => {
      if (changedId === projectId) read()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId])

  return state?.projectId === projectId && state.on
}
