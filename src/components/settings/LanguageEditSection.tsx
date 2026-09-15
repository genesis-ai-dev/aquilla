// AQU-1086: org-level "who can change project languages" control.
//
// Second write-gating permission-policy row, built on the same shape as
// TermbaseEditSection (termbaseEditMinRole) — read that file first; the two
// differ in exactly two ways:
//
//   1. Its default is Maintainer (600), not Project lead. 600 is the floor
//      every project setting has always sat behind, so leaving this alone
//      preserves today's behaviour byte-for-byte and an org opts IN to
//      project-lead language editing.
//   2. Its scope is the language keys — `sourceLanguage`, `targetLanguage`,
//      and the extra-lane registry (`targetLanes` / `archivedLanes`). Lanes
//      ride along with the default target on purpose: a lead who can change
//      the default target must be able to add/archive a lane too, or the
//      Project Info and Languages cards disagree (AQU-898).
//
// Editable only by org owners (OWNER-only write gate, enforced server-side in
// auth-worker/src/routes/org-settings.ts): a maintainer must not be able to
// hand out language editing on their own authority. Lowering the floor affects
// languages ONLY — every other project setting stays maintainer-gated (see the
// language-scoped carve-out in auth-worker project-settings.ts).

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ROLE } from "@/lib/frontier/roles"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface LanguageEditSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

// The closed-trigger text comes from FLOOR_LABEL (short); labelKey is the
// fuller sentence shown in the open dropdown list, below.
//
// Only two options: the ask is "let project managers fix languages", and
// anything below Project lead would hand language changes to translators —
// out of scope for this setting.
const LANGUAGE_ROLE_OPTIONS: { level: number; labelKey: MessageKey }[] = [
  { level: ROLE.PROJECT_LEAD, labelKey: "settings.languageEdit.optionProjectLead" },
  { level: ROLE.MAINTAINER, labelKey: "settings.languageEdit.optionMaintainer" },
]

export function LanguageEditSection({ orgSettings, canEdit }: LanguageEditSectionProps) {
  const { t } = useI18n()
  const { languageEditMinRole, patch } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(newLevel: number) {
    setBusy(true)
    setError(null)
    const result = await patch({ languageEditMinRole: newLevel })
    if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setError(t("settings.languageEdit.ownerOnlyError"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.languageEdit.label")}
      description={t("settings.languageEdit.description")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Select
            items={LANGUAGE_ROLE_OPTIONS.map((opt) => ({
              value: String(opt.level),
              label: FLOOR_LABEL[opt.level] ?? t(opt.labelKey),
            }))}
            value={String(languageEditMinRole)}
            onValueChange={(v) => { if (v) void handleChange(Number(v)) }}
            disabled={!canEdit || busy}
          >
            <SelectTrigger
              id="language-min-role"
              aria-label={t("settings.languageEdit.label")}
              className="w-44"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LANGUAGE_ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
