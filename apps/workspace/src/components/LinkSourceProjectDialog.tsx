// Phase 5 / AD-9. Modal for picking an upstream source project to link
// the current project to. Project-lead+ only.
//
// The list of candidates comes from `useAccessibleProjects` — any
// project the caller can see on the server. We filter out:
//   - the current project itself (server also rejects this with 400)
//   - any project that's already downstream of the current one (server
//     rejects with 409 "would create a cycle" but pre-filtering keeps
//     the picker honest)
//
// Errors from the server are mapped to plain-English strings via
// `useProjectSource.error` and surfaced inline.

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAccessibleProjects } from "@/hooks/useAccessibleProjects"
import { useDownstreamProjects } from "@/hooks/useDownstreamProjects"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** Disables the submit button while a parent mutation is in flight. */
  isMutating?: boolean
  /** Surface from `useProjectSource.error`. */
  error?: string | null
  /** Called when the user picks a candidate and clicks "Link". The
   *  parent owns the link action so it can re-use one source-of-truth
   *  for the project's link state (`useProjectSource.link`). */
  onSubmit: (sourceProjectId: string) => Promise<boolean> | boolean
}

export function LinkSourceProjectDialog({
  open,
  onOpenChange,
  projectId,
  isMutating,
  error,
  onSubmit,
}: Props) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { projects, isLoading } = useAccessibleProjects()
  const { downstreams } = useDownstreamProjects({
    projectId,
    getToken: () => jwt,
    enabled: open,
  })
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<string | null>(null)

  // Reset the picker each time the dialog opens. Doing this in the
  // onOpenChange handler instead of an effect avoids
  // react-hooks/set-state-in-effect — and is more accurate semantically
  // since "open" is the trigger, not arbitrary re-renders.
  function handleOpenChange(next: boolean) {
    if (next) {
      setQuery("")
      setPicked(null)
    }
    onOpenChange(next)
  }

  const downstreamIds = useMemo(() => new Set(downstreams.map((d) => d.id)), [downstreams])

  const candidates = useMemo<CloudProjectSummary[]>(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((p) => {
      if (p.id === projectId) return false
      if (downstreamIds.has(p.id)) return false
      if (!q) return true
      return p.name.toLowerCase().includes(q)
    })
  }, [projects, projectId, downstreamIds, query])

  async function handleSubmit() {
    if (!picked) return
    const ok = await onSubmit(picked)
    if (ok) handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to source project</DialogTitle>
          <DialogDescription>
            Pick an upstream project. Your translations will be read against the
            source cells of the upstream — when its source changes, you'll see a
            "source updated" indicator on affected cells.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your projects…"
              className="pl-8"
              aria-label="Search projects"
            />
          </div>
          <div className="max-h-64 overflow-y-auto rounded border bg-background">
            {isLoading && candidates.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Loading your projects…
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {projects.length === 0
                  ? "No accessible projects to link to."
                  : "No matching projects."}
              </p>
            ) : (
              <ul className="divide-y" role="listbox">
                {candidates.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={picked === p.id}
                      onClick={() => setPicked(p.id)}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${
                        picked === p.id ? "bg-accent" : ""
                      }`}
                    >
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Role: {p.role.name}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            onClick={handleSubmit}
            disabled={!picked || Boolean(isMutating)}
          >
            {isMutating ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
