import { useEffect, useState } from "react"
import { Cloud, Loader2, AlertTriangle, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { isProjectDirty } from "@/lib/sync/dirty"
import { patchProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { SyncPhase, SyncResult } from "@/lib/sync/git-sync"
import type { FrontierSession } from "@/lib/frontier/types"

interface SyncButtonProps {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord | undefined) => void
  sync: (project: ProjectRecord, session: FrontierSession) => Promise<SyncResult | null>
  phase: SyncPhase
  inFlight: boolean
  lastResult: SyncResult | null
}

const PHASE_LABELS: Record<SyncPhase, string> = {
  "idle": "Syncing",
  "checking-dirty": "Checking",
  "serializing": "Serializing",
  "writing": "Writing",
  "committing": "Committing",
  "merging": "Merging",
  "rehydrating": "Rehydrating",
  "pushing": "Pushing",
  "done": "Done",
  "error": "Error",
  "remote-moved": "Remote moved",
}

export function SyncButton({ project, onUpdated, sync, phase, inFlight, lastResult }: SyncButtonProps) {
  const { session } = useFrontierSession()
  const perms = useProjectPermissions(project)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    function check() {
      isProjectDirty(project).then((d) => { if (!cancelled) setDirty(d) })
    }
    check()
    const id = window.setInterval(check, 3000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [project])

  if (!perms.canPush || !session) return null

  async function onClick() {
    if (!session) return
    const r = await sync(project, session)
    if ((r?.status === "synced" || r?.status === "merged") && r.commitSha && project.origin?.kind === "git") {
      const updated = await patchProject(project.id, (p) => ({
        ...p,
        origin: { ...p.origin!, headSha: r.commitSha },
      }))
      onUpdated(updated)
    }
  }

  const isError = lastResult?.status === "error" && !inFlight
  const errorMessage = isError ? (lastResult?.message ?? "unknown error") : null

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant={isError ? "destructive" : dirty ? "default" : "ghost"}
        onClick={onClick}
        disabled={inFlight}
        title={
          isError
            ? `Sync failed: ${errorMessage}`
            : inFlight
              ? PHASE_LABELS[phase]
              : dirty
                ? "Sync local changes (Cmd/Ctrl+S)"
                : "All changes synced"
        }
      >
        {inFlight ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : isError ? (
          <AlertTriangle className="mr-1 h-3.5 w-3.5" />
        ) : dirty ? (
          <Cloud className="mr-1 h-3.5 w-3.5" />
        ) : (
          <Check className="mr-1 h-3.5 w-3.5 text-green-600" />
        )}
        {inFlight
          ? PHASE_LABELS[phase]
          : isError
            ? "Sync failed — retry"
            : dirty
              ? "Sync"
              : "Synced"}
      </Button>
      {errorMessage && (
        <span className="max-w-xs truncate text-xs text-destructive" title={errorMessage}>
          {errorMessage}
        </span>
      )}
    </div>
  )
}
