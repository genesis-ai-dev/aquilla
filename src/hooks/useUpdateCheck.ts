import { useEffect, useState } from "react"

declare const __APP_SHA__: string

const POLL_MS = 60_000

export function useUpdateCheck(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    if (import.meta.env.DEV) return

    let alive = true
    const check = async () => {
      try {
        const res = await fetch(`/version.json?_=${Date.now()}`, {
          cache: "no-store",
        })
        if (!res.ok) return
        const { sha } = (await res.json()) as { sha?: string }
        if (sha && sha !== __APP_SHA__ && alive) setAvailable(true)
      } catch {
        /* network blip — retry next tick */
      }
    }

    const id = setInterval(check, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  return available
}
