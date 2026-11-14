import type { ReactNode } from "react"
import { useParams } from "react-router-dom"
import { ProjectElevationBoundary } from "@/components/ProjectElevationBoundary"
import { peekSessionJwt } from "@/lib/frontier/session-store"
import { warmSyncToken } from "@/lib/sync/sync-token"

/**
 * Route element for **every** `/project/:id/...` workspace surface.
 *
 * It has to sit on all of them, not just `/agent`. `<Routes>` renders its match
 * into one child slot, so React reconciles surface hops by element *type* at
 * that slot. AQU-806 wrapped the agent route alone, which made the type change
 * on an editor → agent hop: React unmounted `ProjectWorkspace` and mounted a
 * fresh one. The open file lives in that component's state and the agent URL
 * carries no file in its path, so the rebuilt workspace had no file and the
 * workbench showed "Choose a file" (AQU-1496). Wrapping every surface keeps the
 * type — and therefore the instance and its open file — stable across the hop.
 *
 * It redirects nothing today. The AQU-806 guard it used to carry sent the agent
 * surface back to the editor on a compact viewport, because the three-pane
 * workbench did not fit there; the Team workspace is single-column below `lg`,
 * so Agent stays reachable on a phone. A route-level guard that comes back
 * belongs in here, keyed on the path — never as a wrapper on one surface.
 *
 * OPS-44: it also hosts the ProjectElevationBoundary, which remounts the
 * workspace once an admin step-up unblocks this project's sync-token mint.
 */
export function ProjectWorkspaceRoute({ children }: { children: ReactNode }) {
  const { id, fileId } = useParams<{ id: string; fileId?: string }>()
  // The workspace module is lazy. The account provider has already rendered
  // the session by the time this route renders, so the mint starts here,
  // before that chunk's effects, and the file minter joins the same request.
  const jwt = peekSessionJwt()
  if (jwt && id && fileId) warmSyncToken(jwt, id, fileId)
  return <ProjectElevationBoundary>{children}</ProjectElevationBoundary>
}
