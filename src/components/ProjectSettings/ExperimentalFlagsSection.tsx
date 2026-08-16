// Experimental feature toggles (src/lib/features/flags.ts registry).
//
// Flags are DEVICE-LOCAL by design: they live on the IDB project record
// (`ProjectRecord.experimentalFlags`), never in ProjectWideSettings, so this
// section saves immediately via patchProject — no role floor, no deferred
// Save bar, no conflict with the shared-settings PATCH (mirrors the
// user-API-key immediate-save path in the parent page).

import { useCallback, useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { FLAGS } from "@/lib/features/flags"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { getProject, patchProject, updateProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ExperimentalFlagsSection({
  projectId,
  serverProject,
}: {
  projectId: string
  /** Server-hydrated record from the parent's read hook. Used only to upsert
   *  a real IDB record when this device has never cached the project —
   *  patchProject is read-then-apply and silently no-ops on a cache miss,
   *  which would make the toggle a no-op on first visit. */
  serverProject?: ProjectRecord
}) {
  const { t } = useI18n()
  const [flags, setFlags] = useState<Record<string, boolean> | undefined>(undefined)

  // Seed from IDB directly — the parent's `project` comes from the server
  // read hook, which never carries device-local flags.
  useEffect(() => {
    let cancelled = false
    void getProject(projectId).then((local) => {
      if (!cancelled) setFlags(local?.experimentalFlags)
    })
    return () => { cancelled = true }
  }, [projectId])

  const setFlag = useCallback((key: string, value: boolean) => {
    setFlags((prev) => ({ ...prev, [key]: value }))
    void (async () => {
      const patched = await patchProject(projectId, (latest) => ({
        ...latest,
        experimentalFlags: { ...latest.experimentalFlags, [key]: value },
      }))
      if (patched || !serverProject) return
      // Cache miss: seed IDB with the real server record so the flag has a
      // home. A full record is safe on the Dashboard (it is a real project).
      await updateProject({ ...serverProject, experimentalFlags: { [key]: value } })
    })()
  }, [projectId, serverProject])

  return (
    <div id="section-experimental">
      <SettingsGroup label={t("autopilot.settings.experimentalTitle")}>
        {Object.entries(FLAGS).map(([key, def]) => (
          <SettingsRow
            key={key}
            label={<label htmlFor={`experimental-${key}`}>{t(def.labelKey)}</label>}
            description={t(def.descriptionKey)}
            control={
              <Switch
                id={`experimental-${key}`}
                checked={flags?.[key] ?? def.default}
                onCheckedChange={(checked) => setFlag(key, checked)}
                aria-label={t(def.labelKey)}
              />
            }
          />
        ))}
      </SettingsGroup>
      <p className="mt-2 px-4 text-xs text-muted-foreground">
        {t("autopilot.settings.experimentalDescription")}
      </p>
    </div>
  )
}
