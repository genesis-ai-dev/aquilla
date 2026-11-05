// The Bible versions a translator has chosen, and the helloao catalogue that
// names them. Shared by the editor's Bible columns and the Parallel Bibles
// panel, so both always show the same versions.

import { useEffect, useMemo, useState } from "react"
import { fetchHelloaoTranslations, type HelloaoTranslation } from "@/lib/parsers/helloao"
import {
  clearPersonalPins,
  PINS_CHANGED_EVENT,
  readPersonalPins,
  resolvePinnedVersions,
  writePersonalPins,
  type PinSource,
} from "@/lib/parallel-bibles/pinned-versions"

export interface PinnedVersions {
  pinned: string[]
  source: PinSource
  pin: (id: string) => void
  unpin: (id: string) => void
  /** Drop this project's own pins so the project defaults show. */
  followProjectDefaults: () => void
}

export function usePinnedVersions(
  projectId: string | undefined,
  projectDefaults: readonly string[] | undefined,
): PinnedVersions {
  const [personal, setPersonal] = useState<string[] | null>(() => readPersonalPins(projectId))

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string | null }>).detail
      if ((detail?.projectId ?? null) === (projectId ?? null)) setPersonal(readPersonalPins(projectId))
    }
    window.addEventListener(PINS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(PINS_CHANGED_EVENT, onChange)
  }, [projectId])

  const resolved = resolvePinnedVersions(personal, projectDefaults)
  // One string so a fresh-but-equal defaults array doesn't refetch.
  const pinnedKey = resolved.ids.join(",")
  const pinned = useMemo(() => (pinnedKey ? pinnedKey.split(",") : []), [pinnedKey])

  const source = resolved.source
  return useMemo(() => {
    const save = (next: string[]) => {
      setPersonal(next)
      writePersonalPins(projectId, next)
    }
    return {
      pinned,
      source,
      pin: (id: string) => {
        if (!pinned.includes(id)) save([...pinned, id])
      },
      unpin: (id: string) => save(pinned.filter((v) => v !== id)),
      followProjectDefaults: () => {
        if (projectId) clearPersonalPins(projectId)
        setPersonal(null)
      },
    }
  }, [pinned, source, projectId])
}

export interface HelloaoCatalogue {
  translations: HelloaoTranslation[] | null
  error: string | null
  retry: () => void
  byId: ReadonlyMap<string, HelloaoTranslation>
}

/** The catalogue, fetched lazily once `needed` (module-cached by the client). */
export function useHelloaoCatalogue(needed: boolean): HelloaoCatalogue {
  const [translations, setTranslations] = useState<HelloaoTranslation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `error` guards against a retry loop; clearing it from Retry re-arms the fetch.
  useEffect(() => {
    if (!needed || translations || error) return
    let cancelled = false
    fetchHelloaoTranslations()
      .then((list) => {
        if (!cancelled) setTranslations(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [needed, translations, error])

  const byId = useMemo(() => {
    const map = new Map<string, HelloaoTranslation>()
    for (const tr of translations ?? []) map.set(tr.id, tr)
    return map
  }, [translations])

  return useMemo(() => ({ translations, error, retry: () => setError(null), byId }), [translations, error, byId])
}

/** The short name a column or card shows for a version. */
export function versionLabel(id: string, meta: HelloaoTranslation | undefined): string {
  return meta ? meta.shortName || meta.id : id
}
