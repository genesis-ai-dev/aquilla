import { useEffect, useMemo, useState } from "react"
import { FRONTIER_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"

type ProjectName = { id: string; name: string; orgId: number }
type NameIndex = { revision: string; projects: ProjectName[] }
let account: string | null = null
const pages = new Map<string, NameIndex>()

export function useProjectNameIndex(jwt: string | null, ids: number[], enabled: boolean, refreshKey: number) {
  const request = useMemo(() => ({ jwt, ids, enabled, refreshKey }), [jwt, ids, enabled, refreshKey])
  const [ready, setReady] = useState<{ request: typeof request; index: NameIndex } | null>(null)
  useEffect(() => {
    if (account !== jwt) {
      pages.clear()
      account = jwt
    }
    if (!enabled || !jwt || !ids.length) return
    const scope = ids.join(",")
    const controller = new AbortController()
    async function refresh() {
      const cached = pages.get(scope)
      const response = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/project-name-index`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ orgIds: ids, revision: cached?.revision }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error("Project name index unavailable")
      const body = await response.json() as {
        revision: string; unchanged?: boolean; projects?: [string, string, number][]
      }
      const index = body.unchanged && cached?.revision === body.revision ? cached :
        Array.isArray(body.projects) ? {
          revision: body.revision,
          projects: body.projects.map(([id, name, orgId]) => ({ id, name, orgId })),
        } : null
      if (!index || controller.signal.aborted || account !== jwt || !jwt) return
      pages.set(scope, index)
      setReady({ request, index: { ...index } })
    }
    // If the index is unavailable, the directory's normal server search remains available.
    void refresh().catch(() => {})
    return () => controller.abort()
  }, [jwt, ids, enabled, request])
  return ready?.request === request ? ready.index : null
}
