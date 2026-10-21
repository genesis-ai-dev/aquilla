import { useEffect, useRef } from "react"
import { subscribeWindowRegainedFocus } from "@/lib/sync/window-focus-revalidate"

/**
 * AQU-1913: re-read a progress page's numbers when a setting that moves them
 * may have changed behind it.
 *
 * "Count headings as translatable content" and the validation counts change
 * every percentage without a single cell changing. A change made in THIS tab
 * already reaches an open overview (AQU-1493's settings-updated event, and
 * the org-settings broadcast). One made by another person, another tab or an
 * agent did not: the project and org overviews, the plan board and the Team
 * card kept the old numbers until a reload. Two signals cover it:
 *
 *   - Coming back to the tab. The same shared, throttled coordinator
 *     useProjectSettings uses, so one alt-tab is one wave of reads for the
 *     whole page, never one per hook, and a quick peek away reads nothing.
 *   - The org's settings version moving. useOrgSettings re-reads the org row
 *     on return and adopts a sibling's write, so its `version` is how the
 *     page learns an org default changed. Only a CHANGE counts: the first
 *     version this hook sees (the initial load, or the first one for a newly
 *     selected org) is what the page's numbers were already read against.
 *
 * `reread` should be stable (a useCallback): a new one re-subscribes. It must
 * re-read everything the page shows from server-computed counts.
 */
export function useRereadWhenSettingsMayHaveMoved(
  reread: () => void,
  options: { enabled: boolean; orgId: number | null | undefined; orgSettingsVersion: number | null | undefined },
): void {
  const { enabled, orgId, orgSettingsVersion } = options

  useEffect(() => {
    if (!enabled) return
    return subscribeWindowRegainedFocus(reread)
  }, [enabled, reread])

  const seenRef = useRef<{ orgId: number; version: number } | null>(null)
  useEffect(() => {
    if (!enabled || orgId == null || orgSettingsVersion == null) return
    const seen = seenRef.current
    seenRef.current = { orgId, version: orgSettingsVersion }
    if (seen && seen.orgId === orgId && seen.version !== orgSettingsVersion) reread()
  }, [enabled, orgId, orgSettingsVersion, reread])
}
