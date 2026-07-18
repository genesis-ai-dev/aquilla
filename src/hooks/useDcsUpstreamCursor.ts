// Read the project's pinned DCS upstream cursor (project_settings key
// "dcsUpstream") for capability gating. A present cursor means the project is
// a Door43-linked adapter whose source lane must not be hand-edited — the DCS
// repair path treats any local source divergence as damage and overwrites it.
//
// `loading` stays true until the settings GET has resolved. Callers gating a
// destructive-if-wrong affordance (EditorTable's "Edit source") should treat
// loading as LOCKED: default-locked can never let a doomed edit through, and
// the cost is only a one-round-trip delay of the affordance for cloud
// project_lead+ users. (For local / logged-out projects `loading` may stay
// true forever — harmless, because canEditSource is already false there.)

import { useMemo } from "react"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { readCursor } from "@/lib/dcs/cursor"
import type { DcsCursor } from "@/lib/dcs/types"

export interface UseDcsUpstreamCursor {
  /** The pinned cursor, or null if absent / detached (explicit null) / malformed. */
  cursor: DcsCursor | null
  /** True until the first settings fetch resolves — treat as "linked-state unknown". */
  loading: boolean
}

export function useDcsUpstreamCursor(
  projectId: string | null,
  roleLevel: number | null,
): UseDcsUpstreamCursor {
  const { settings, hasFetched } = useProjectSettings(projectId, roleLevel)
  const cursor = useMemo(
    () => readCursor(settings as Record<string, unknown>),
    [settings],
  )
  return { cursor, loading: !hasFetched }
}
