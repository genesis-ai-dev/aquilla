/**
 * AQU-1937: is the per-project "Smart Extensions" switch on? Read from the
 * project's settings blob (`smartExtensionsEnabled`, shared/tools/
 * smart-extensions-flag.ts) through the ordinary settings read, cached per
 * project, and re-read when the settings page flips it. Off (the default, and
 * on any read failure) = no extensions UI at all.
 */

import { useEffect, useState } from "react"
import { fetchProjectSettings } from "@/lib/sync/project-settings"
import { smartExtensionsEnabledIn } from "../../../shared/tools/smart-extensions-flag"

const EVENT = "aquilla:smart-extensions-changed"
const cache = new Map<string, Promise<boolean>>()

export function readSmartExtensionsEnabled(jwt: string, projectId: string): Promise<boolean> {
  let p = cache.get(projectId)
  if (!p) {
    p = fetchProjectSettings(jwt, projectId)
      .then((s) => smartExtensionsEnabledIn(s?.settings ?? null))
      .catch(() => false)
    cache.set(projectId, p)
  }
  return p
}

export function notifySmartExtensionsChanged(projectId: string | undefined): void {
  if (projectId) cache.delete(projectId)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: projectId ?? null }))
}

/** null while unknown (callers treat it as off but may wait), then the answer. */
export function useSmartExtensionsEnabled(jwt: string | null, projectId: string): boolean | null {
  const [state, setState] = useState<{ key: string; on: boolean } | null>(null)
  const key = `${projectId}:${jwt ? "1" : "0"}`
  const [bump, setBump] = useState(0)
  useEffect(() => {
    const on = () => setBump((n) => n + 1)
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  useEffect(() => {
    if (!jwt || !projectId) return
    let alive = true
    void readSmartExtensionsEnabled(jwt, projectId).then((on) => {
      if (alive) setState({ key, on })
    })
    return () => {
      alive = false
    }
  }, [jwt, projectId, key, bump])
  return state && state.key === key ? state.on : null
}
