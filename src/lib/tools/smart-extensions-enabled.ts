/**
 * AQU-1937: is the per-project "Smart Extensions" switch on? Read from the
 * project's settings blob (`smartExtensionsEnabled`, shared/tools/
 * smart-extensions-flag.ts) through the ordinary settings read, cached per
 * project, and re-read when the settings page flips it. Off (the default, and
 * on any read failure) = no extensions UI at all.
 */

import { useEffect, useState } from "react"
import { readProjectSettingsShared } from "@/lib/sync/project-settings-shared-read"
import { smartExtensionsEnabledIn } from "../../../shared/tools/smart-extensions-flag"

const EVENT = "aquilla:smart-extensions-changed"
const cache = new Map<string, Promise<boolean>>()
// Projects whose switch was flipped since their last read: the re-read follows
// a write, so it must not be answered by a settings read from before it.
const flipped = new Set<string>()

export function readSmartExtensionsEnabled(jwt: string, projectId: string): Promise<boolean> {
  let p = cache.get(projectId)
  if (!p) {
    // AQU-2654: the same GET the page's useProjectSettings instances send, so
    // it rides on theirs instead of being one more.
    p = readProjectSettingsShared(jwt, projectId, flipped.delete(projectId) ? "afterWrite" : "mount")
      .then((out) => smartExtensionsEnabledIn(out.ok ? (out.value?.settings ?? null) : null))
      .catch(() => false)
    cache.set(projectId, p)
  }
  return p
}

export function notifySmartExtensionsChanged(projectId: string | undefined): void {
  if (projectId) {
    cache.delete(projectId)
    flipped.add(projectId)
  }
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
