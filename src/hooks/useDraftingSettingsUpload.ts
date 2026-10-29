// AQU-2259: the ONE-TIME UPLOAD of a browser's old AI drafting settings.
//
// Before AQU-2259 the drafting settings (the "AI Instructions" card, the model
// choice, the Health penalty) lived only in the browser that set them. They
// are the team's settings now (`draftingSettings` in the shared blob). The
// values people already tuned exist only in their browsers, so: when someone
// who may change project settings opens the project, the server has no
// drafting settings yet, and their browser holds values that differ from the
// defaults, those values become the team's. The first browser to get there
// wins; after that nobody's local copy is read (the overlay lays the shared
// value over every record, src/hooks/project-settings-overlay.ts).
//
// THIS RULE IS NOT FINAL (Sam, Oct 29), so it lives here alone, behind one
// call in useProjectSettings, and nothing else depends on it. To swap it:
//   - "Start everyone on the defaults": delete that call, and make the
//     overlay read the defaults (not the record's own values) when the blob
//     has no `draftingSettings` — the one `if (drafting)` in the overlay.
//   - "Ask once": keep the decision (`draftingSettingsToUpload`) and replace
//     the automatic write below with a prompt whose Yes runs `uploadOnce`.

import { useEffect } from "react"
import { getProject } from "@/lib/store/project-index"
import {
  fetchProjectSettingsResult,
  patchProjectSettings,
  type PatchResult,
  type ProjectSettingsResponse,
} from "@/lib/sync/project-settings"
import { draftingSettingsToUpload, type DraftingSettings } from "@/lib/completion/drafting-settings"

/** Projects this page load has already tried, so one open tries once. */
const attempted = new Set<string>()

/** Test seam: forget which projects were tried. */
export function resetDraftingSettingsUploadsForTests(): void {
  attempted.clear()
}

/**
 * Write `value` as the project's drafting settings unless somebody already
 * did. Re-reads the row first and never retries a conflict: a conflict means
 * another writer moved the row, and if that writer set drafting settings,
 * theirs were first. Returns null when the read failed.
 */
async function uploadOnce(
  jwt: string,
  projectId: string,
  value: DraftingSettings,
): Promise<PatchResult | null> {
  const probe = await fetchProjectSettingsResult(jwt, projectId)
  const fresh = probe.ok ? probe.value : null
  if (!fresh) return null
  if (fresh.settings.draftingSettings != null) return { kind: "conflict", latest: fresh }
  return patchProjectSettings(jwt, projectId, { ...fresh.settings, draftingSettings: value }, fresh.version)
}

export function useDraftingSettingsUpload(args: {
  projectId: string | null
  jwt: string | null
  /** May this person change project settings (maintainer, online)? */
  canEdit: boolean
  hasFetched: boolean
  server: ProjectSettingsResponse | null
  /** The owning hook's write queue, so this never races its other writes. */
  runSerialized: <T>(fn: () => Promise<T>) => Promise<T>
  /** A row the server returned; `wrote` when it is this upload's own write. */
  onServerResponse: (response: ProjectSettingsResponse, wrote: boolean) => void
}): void {
  const { projectId, jwt, canEdit, hasFetched, server, runSerialized, onServerResponse } = args
  const serverHasDrafting = server?.settings.draftingSettings != null
  useEffect(() => {
    if (!projectId || !jwt || !canEdit || !hasFetched || !server) return
    if (serverHasDrafting) return
    if (attempted.has(projectId)) return
    attempted.add(projectId)
    void (async () => {
      let local
      try {
        local = await getProject(projectId)
      } catch {
        return
      }
      const value = draftingSettingsToUpload({
        canEdit: true,
        serverDrafting: null,
        local: local?.completionSettings,
      })
      if (!value) return
      const out = await runSerialized(() => uploadOnce(jwt, projectId, value))
      if (out?.kind === "ok") onServerResponse(out.value, true)
      else if (out?.kind === "conflict") onServerResponse(out.latest, false)
    })()
  }, [projectId, jwt, canEdit, hasFetched, server, serverHasDrafting, runSerialized, onServerResponse])
}
