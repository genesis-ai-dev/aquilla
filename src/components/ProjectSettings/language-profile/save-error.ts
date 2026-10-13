// A failed Language-profile save, as the card says it (AQU-1688, shared by the
// AQU-1691 rows). The settings hook resolves an outcome instead of throwing,
// so a caller that ignored it would swallow a role, offline or conflict failure.

import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { TFunction } from "@/lib/i18n/I18nProvider"

/** Null when the save landed, else the message to show. */
export function profileSaveError(outcome: PatchOutcome, t: TFunction): string | null {
  if (outcome.kind === "ok") return null
  if (outcome.kind === "conflict") return t("bibleData.profile.error.conflict")
  if (outcome.kind === "blocked") {
    return outcome.reason === "offline" ? t("bibleData.profile.error.offline") : t("bibleData.profile.error.permission")
  }
  return t("bibleData.profile.error.failed")
}
