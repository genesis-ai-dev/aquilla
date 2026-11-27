/**
 * AQU-2323: the person inspector's one read. AD-3 thin client: plain
 * `useState` + race-guarded `useEffect`, keyed by the (org, person) it was
 * fetched for, so one person's answer never renders under another's URL.
 * `reload()` keeps the current answer on screen until the new one lands, so
 * a grant made from the page moves its place without the page blanking.
 */
import { useCallback, useEffect, useState } from "react"

import { fetchPersonAccess, type PersonAccessPayload } from "@/components/org/access/person-access-data"
import { useFrontierSession } from "@/hooks/useFrontierSession"

export type PersonAccessState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: PersonAccessPayload; reload: () => void }

type Loaded = { key: string; data: PersonAccessPayload | null; error: boolean }

export function usePersonAccess(orgId: number | null, userId: string | undefined): PersonAccessState {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  const key = orgId != null && userId ? `${orgId}:${userId}` : null

  useEffect(() => {
    if (!jwt || orgId == null || !userId || !key) return
    let cancelled = false
    fetchPersonAccess(jwt, orgId, userId).then(
      (data) => { if (!cancelled) setLoaded({ key, data, error: false }) },
      () => { if (!cancelled) setLoaded({ key, data: null, error: true }) },
    )
    return () => { cancelled = true }
  }, [jwt, orgId, userId, key, version])

  if (!jwt || !key || loaded?.key !== key) return { status: "loading" }
  if (loaded.error || !loaded.data) return { status: "error" }
  return { status: "ready", data: loaded.data, reload }
}
