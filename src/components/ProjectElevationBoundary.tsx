import { Fragment, useEffect, useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { onElevationGranted } from "@/lib/errors/elevation-required-signal"

/**
 * OPS-44: reload a project's page once an admin step-up unblocks it.
 *
 * A platform admin who reaches a project only through platform power cannot
 * mint its sync token until they verify the emailed code. Until then every
 * sync-worker read on the page fails (cells, file progress, the live socket,
 * the plan, comments), and each read hook gives up on its own schedule. Rather
 * than teach every hook to retry, this remounts the page when the grant names
 * this route's project: the same fresh start a reload gives, without dropping
 * the session or the outbox.
 *
 * A grant that follows only membership/admin refusals leaves the page alone,
 * so a half-filled form in it survives. Sits on every `/project/:id` and
 * `/projects/:id` surface that reads project data; inside ProjectWorkspaceRoute
 * the key never changes on a surface hop, so the workspace keeps its instance.
 */
export function ProjectElevationBoundary({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!id) return
    return onElevationGranted((refused) => {
      if (refused.has(id)) setGeneration((g) => g + 1)
    })
  }, [id])

  return <Fragment key={generation}>{children}</Fragment>
}
