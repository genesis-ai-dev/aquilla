import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "./FrontierLoginForm"
import { RepoPickerList } from "./RepoPickerList"
import { CloneProgress } from "./CloneProgress"
import { importFromGitRepo } from "@/lib/importer/git-importer"
import type { GitlabProject } from "@/lib/frontier/types"

type Stage =
  | { kind: "auth-or-pick" }
  | {
      kind: "importing"
      phase: "clone" | "parse" | "persist"
      done: number
      total: number
      label: string
      project: GitlabProject
    }
  | { kind: "done"; projectId: string }
  | { kind: "error"; message: string }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (projectId: string) => void
}

export function GitImportDialog({ open, onOpenChange, onImported }: Props) {
  const { session, loading, logout } = useFrontierSession()
  const [stage, setStage] = useState<Stage>({ kind: "auth-or-pick" })

  async function startImport(project: GitlabProject) {
    if (!session) return
    setStage({ kind: "importing", phase: "clone", done: 0, total: 1, label: project.name, project })
    try {
      const imported = await importFromGitRepo({
        session,
        project,
        onPhase: (phase, done, total, label) =>
          setStage({ kind: "importing", phase, done, total, label, project }),
      })
      setStage({ kind: "done", projectId: imported.project.id })
      onImported(imported.project.id)
    } catch (e) {
      setStage({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from git</DialogTitle>
        </DialogHeader>

        {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}

        {!loading && stage.kind === "auth-or-pick" && (
          session ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Signed in as {session.username}</p>
                <Button size="sm" variant="ghost" onClick={logout}>
                  Log out
                </Button>
              </div>
              <RepoPickerList session={session} onPick={startImport} />
            </div>
          ) : (
            <FrontierLoginForm onSuccess={() => setStage({ kind: "auth-or-pick" })} />
          )
        )}

        {stage.kind === "importing" && (
          <CloneProgress phase={stage.phase} done={stage.done} total={stage.total} label={stage.label} />
        )}

        {stage.kind === "done" && (
          <div className="space-y-3 p-4">
            <p className="text-sm">Import complete.</p>
            <Button onClick={() => onOpenChange(false)} className="w-full">
              Close
            </Button>
          </div>
        )}

        {stage.kind === "error" && (
          <div className="space-y-3 p-4">
            <p className="text-sm text-destructive">{stage.message}</p>
            <Button onClick={() => setStage({ kind: "auth-or-pick" })} className="w-full">
              Try again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
