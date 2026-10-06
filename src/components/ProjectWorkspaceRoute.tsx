import type { ReactNode } from "react"

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
 */
export function ProjectWorkspaceRoute({ children }: { children: ReactNode }) {
  return <>{children}</>
}
