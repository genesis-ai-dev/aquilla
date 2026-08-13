import { useEffect, useState } from "react"
import { useParams, useLocation } from "react-router-dom"
import { listProjects, getProject } from "@/lib/store/project-index"
import { Spinner } from "@/components/ui/spinner"

export function DebugView() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const [state, setState] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      if (!id) {
        const projects = await listProjects()
        setState({ projects })
      } else if (location.pathname.includes("/settings/debug")) {
        const project = await getProject(id)
        setState({
          project: project || null,
          completionSettings: project?.completionSettings || null,
          username: project?.username || "local",
        })
      } else {
        const project = await getProject(id)
        setState({
          project: project || null,
          files: project?.files || [],
        })
      }
      setLoading(false)
    }
    load()
  }, [id, location.pathname])

  if (loading) {
    return (
      <div className="flex items-center p-4 text-muted-foreground">
        <Spinner />
      </div>
    )
  }

  return (
    <pre style={{ padding: "1rem", fontFamily: "monospace", fontSize: "0.875rem" }}>
      {JSON.stringify(state, null, 2)}
    </pre>
  )
}
