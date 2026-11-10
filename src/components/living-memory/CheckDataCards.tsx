/**
 * The data the Bible data checks verify against, in Living Memory → Checks
 * (AQU-2342): the Language profile (AQU-1688) and the decision log (AQU-1691),
 * both shown only with the Bible data experiment on, as they were in Project
 * settings.
 *
 * They save the way they did in settings (AQU-2262): each change goes through
 * `useSettingsCommit`, so it is refused over a teammate's newer change to the
 * same setting, says "Saved" beside the card, and is one step in the project's
 * Undo / History (the workspace behind this page hosts the history and knows
 * how to undo a "settings.project" step). The provider lives here because the
 * rest of the Living Memory page does not record steps.
 */

import { useCallback } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { SaveStatusProvider } from "@/lib/settings/save-status"
import { useSettingsCommit } from "@/components/ProjectSettings/useSettingsCommit"
import { LanguageProfileSection } from "@/components/ProjectSettings/LanguageProfileSection"
import { ProjectDecisionsSection } from "@/components/ProjectSettings/ProjectDecisionsSection"
import { authorNameFor } from "@/lib/store/local-author-name"
import type { PatchOptions, PatchOutcome } from "@/hooks/useProjectSettings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import type { ProjectRecord } from "@/lib/parsers/types"

export interface CheckDataCardsProps {
  project: ProjectRecord
  /** The page's shared settings (the same hook instance `patch` belongs to). */
  settings: ProjectWideSettings
  canEdit: boolean
  /**
   * AQU-1733: the project's own translated text, in reading order, so the
   * Language profile can offer the quotation marks the project already uses.
   */
  sampleTexts?: readonly string[]
  /** Who is editing: an edited decision is theirs, and so is the Undo step. */
  sessionUsername: string | null | undefined
  sessionJwt: string | null | undefined
  patch: (partial: ProjectWideSettings, opts?: PatchOptions) => Promise<PatchOutcome>
}

export function CheckDataCards(props: CheckDataCardsProps) {
  return (
    <SaveStatusProvider>
      <CheckDataCardsInner {...props} />
    </SaveStatusProvider>
  )
}

function CheckDataCardsInner({ project, settings, canEdit, sampleTexts, sessionUsername, sessionJwt, patch }: CheckDataCardsProps) {
  const t = useT()
  const jwt = sessionJwt ?? null
  const getJwt = useCallback(() => jwt, [jwt])
  const commit = useSettingsCommit({
    projectId: project.id,
    project,
    username: authorNameFor(sessionUsername, project.username),
    isCloudProject: !!project.syncRole,
    settings,
    patch,
    getJwt,
    t,
  })
  const disabledTooltip = t("rules.builtinChecks.manageNeedsMaintainer")
  return (
    <>
      <LanguageProfileSection
        value={settings.languageProfile}
        targetLanguage={settings.targetLanguage ?? project.targetLanguage ?? ""}
        sampleTexts={sampleTexts}
        canEdit={canEdit}
        disabledTooltip={disabledTooltip}
        patch={commit.recordedPatch()}
      />
      <ProjectDecisionsSection
        value={settings.projectFacts}
        canEdit={canEdit}
        disabledTooltip={disabledTooltip}
        username={sessionUsername ?? ""}
        patch={commit.recordedPatch({ ownErrors: "all" })}
      />
    </>
  )
}
