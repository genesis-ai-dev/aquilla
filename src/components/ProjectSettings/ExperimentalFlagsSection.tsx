// Experimental features.
//
// TWO kinds of switch live here, and the difference is the point of AQU-1246:
//
//   • The Autopilot opt-in is PROJECT-WIDE and SERVER-STORED
//     (`ProjectWideSettings.autopilotEnabled`), writable only at
//     project_lead(500)+ and enforced by auth-worker. It decides whether the
//     experimental Autopilot surface exists for the project at all — off means
//     the pill, the overview panel and the lane plumbing are ABSENT, not
//     disabled. It used to be the device-local switch below, which is exactly
//     what was wrong: every member of every project was one click from
//     revealing an experiment, and the choice never left their browser.
//
//   • Everything from the `src/lib/features/flags.ts` registry stays
//     DEVICE-LOCAL: it lives on the IDB project record, never in
//     ProjectWideSettings, so switching one on here never changes a
//     collaborator's app. Saved immediately via patchProject — no role floor,
//     no deferred Save bar, no conflict with the shared-settings PATCH
//     (mirrors the user-API-key immediate-save path in the parent page).
//     Registry entries marked `legacy` are read-only grandfathers and are not
//     rendered — `contextualTranslation` is one, honoured for devices that
//     already stored it so no running autopilot is stranded.

import { useCallback, useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { FLAGS } from "@/lib/features/flags"
import { AUTOPILOT_EDIT_ROLE_FLOOR } from "@/hooks/useProjectSettings"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { getProject, patchProject, updateProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ExperimentalFlagsSection({
  projectId,
  serverProject,
  autopilotEnabled,
  roleLevel,
  onSetAutopilotEnabled,
}: {
  projectId: string
  /** Server-hydrated record from the parent's read hook. Used only to upsert
   *  a real IDB record when this device has never cached the project —
   *  patchProject is read-then-apply and silently no-ops on a cache miss,
   *  which would make a device-local toggle a no-op on first visit. */
  serverProject?: ProjectRecord
  /** Current project-wide Autopilot opt-in, from the shared settings blob.
   *  Absent → off. */
  autopilotEnabled?: boolean
  /** Caller's role on this project. `null` = unsynced/local project, which has
   *  no roster to protect, so the opt-in stays available. */
  roleLevel?: number | null
  /** Write the project-wide opt-in through the shared settings PATCH. Omit on
   *  surfaces that have no settings hook — the row then renders read-only. */
  onSetAutopilotEnabled?: (enabled: boolean) => void
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

  // Below project_lead the switch is disabled rather than hidden: a member who
  // can see the setting can see WHY the project has no Autopilot, and who to
  // ask. Hiding it would be the same "it's just not there" confusion the
  // ticket is fixing, one level up. The server refuses the write either way —
  // this control is a courtesy, never the permission (auth-worker
  // project-settings.ts owns that).
  const canOptIn = Boolean(onSetAutopilotEnabled)
    && (roleLevel == null || roleLevel >= AUTOPILOT_EDIT_ROLE_FLOOR)

  // Legacy registry entries are read-only grandfathers — never offered as a
  // toggle (see the module header).
  const deviceFlags = Object.entries(FLAGS).filter(([, def]) => !def.legacy)

  return (
    <div id="section-experimental">
      <SettingsGroup label={t("autopilot.settings.experimentalTitle")}>
        <SettingsRow
          label={<label htmlFor="experimental-autopilot">{t("autopilot.settings.autopilotLabel")}</label>}
          description={t("autopilot.settings.autopilotDescription")}
          control={
            <DisabledFieldTooltip
              disabled={!canOptIn}
              tooltip={t("autopilot.settings.autopilotRoleHint")}
            >
              <Switch
                id="experimental-autopilot"
                checked={autopilotEnabled ?? false}
                disabled={!canOptIn}
                onCheckedChange={(checked) => onSetAutopilotEnabled?.(checked)}
                aria-label={t("autopilot.settings.autopilotLabel")}
              />
            </DisabledFieldTooltip>
          }
        />
        {deviceFlags.map(([key, def]) => (
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
