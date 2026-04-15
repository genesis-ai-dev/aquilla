import { useEffect, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { listAllProjects } from "@/lib/frontier/api"
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types"

interface Props {
  session: FrontierSession
  onPick: (project: GitlabProject) => void
}

export function RepoPickerList({ session, onPick }: Props) {
  const [projects, setProjects] = useState<GitlabProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  useEffect(() => {
    listAllProjects(session).then(setProjects).catch((e) => setError(String(e)))
  }, [session])

  const filtered = useMemo(() => {
    if (!projects) return []
    const q = filter.toLowerCase()
    return projects.filter((p) =>
      p.path_with_namespace.toLowerCase().includes(q) ||
      (p.description ?? "").toLowerCase().includes(q)
    )
  }, [projects, filter])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!projects)
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
      </div>
    )

  return (
    <div className="space-y-2">
      <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="max-h-96 overflow-auto divide-y rounded border">
        {filtered.map((p) => (
          <li key={p.id}>
            <Button
              variant="ghost"
              className="w-full justify-start h-auto py-2"
              onClick={() => onPick(p)}
            >
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm truncate">{p.path_with_namespace}</p>
                {p.description && (
                  <p className="text-xs text-muted-foreground truncate">{p.description}</p>
                )}
              </div>
            </Button>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="p-3 text-sm text-muted-foreground">No matches</li>
        )}
      </ul>
    </div>
  )
}
