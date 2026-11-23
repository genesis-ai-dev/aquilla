import { useEffect, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { laneOptionLabel } from "@/lib/lanes/lane-language"
import { fetchProjectSettingsResult } from "@/lib/sync/project-settings"

export interface TargetLaneOption {
  id: string
  label: string
}

/**
 * Current (non-archived) target lanes the sharer can grant. A failed load
 * stays empty so the form does not invent a lane list; the server still
 * refuses a below-lead add that names no choice when lanes exist.
 *
 * AQU-2635: every option carries readable text. A row that records no
 * language and no name — the former default lane on a project migrated from
 * Codex, whose `legacy_tag` is `''` — used to fall through to that empty tag,
 * so the picker drew a checkbox with nothing beside it AND the grant sentence,
 * which drops blank lane labels, fell back to "every language lane" while the
 * granter had chosen one lane only. `laneOptionLabel` resolves the row's
 * language, never shows an opaque 8-hex lane id, and lands on the same
 * translated "Main language" wording the member lane scope editor uses.
 */
export function useCurrentTargetLanes(projectId: string | null): {
  lanes: TargetLaneOption[]
  ready: boolean
} {
  const { session } = useFrontierSession()
  const { t } = useI18n()
  const mainLanguageFallback = t("org.memberLaneScopeEditor.mainLanguageFallback")
  const jwt = session?.jwt ?? null
  const [lanes, setLanes] = useState<TargetLaneOption[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const requestKey = projectId && jwt ? `${jwt}\0${projectId}` : null

  useEffect(() => {
    if (!projectId || !jwt || !requestKey) return
    let alive = true
    void (async () => {
      try {
        const result = await fetchProjectSettingsResult(jwt, projectId)
        if (!alive) return
        const rows = result.ok ? (result.value?.lanes ?? []) : []
        setLanes(
          rows
            .filter((lane) => lane.role === "target" && !lane.archivedAt)
            .map((lane) => ({
              id: lane.id,
              label: laneOptionLabel(lane, mainLanguageFallback),
            })),
        )
      } catch {
        if (!alive) return
        setLanes([])
      }
      if (alive) setLoadedFor(requestKey)
    })()
    return () => {
      alive = false
    }
  }, [jwt, mainLanguageFallback, projectId, requestKey])

  // A missing session or project is not "loaded empty". Callers that submit
  // anyway still meet the server's refusal when the project has lanes.
  return { lanes: loadedFor === requestKey ? lanes : [], ready: loadedFor === requestKey }
}
