// AQU-1002: org-level comment authority controls.
//
// Two independent write-permission floors, the same shape as AQU-485's
// roster/progress pair and AQU-822's termbase floor:
//   - commentCreateMinRole:  who can open a thread or post a reply
//   - commentResolveMinRole: who can resolve/reopen a thread SOMEBODY ELSE opened
//
// Defaults are the pre-AQU-1002 static floors, so an org that never opens this
// page keeps exactly the behaviour AQU-999 shipped: Commenter to comment,
// Contributor to resolve a foreign thread. Partners genuinely disagreed here —
// some want translators settling the threads on files they translate, others
// want that reserved for maintainers — which is why this is a floor rather
// than a hard-coded rule.
//
// The resolve floor governs OTHER people's threads only. A thread's author can
// always resolve their own, whatever the org sets; the description copy says so
// because otherwise "Maintainer" reads as "nobody below maintainer can ever
// close anything", which is not what it does.
//
// Displayed on /settings/security. Editable only by org owners — stricter than
// the general MAINTAINER settings-write gate, mirroring every other
// permission-policy key (auth-worker/src/routes/org-settings.ts
// PERMISSION_POLICY_KEYS).

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
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

interface CommentPermissionsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

// Unlike the roster/termbase pickers, these two start at COMMENTER (200) —
// commenting is the one thing the commenter role exists for, so a ladder that
// skipped it could not express the default. Viewer (100) is deliberately absent
// from both: viewers have no write path at all, so offering it would promise
// something no floor can deliver.
const COMMENT_CREATE_ROLE_OPTIONS: { level: number; labelKey: MessageKey }[] = [
  { level: ROLE.COMMENTER, labelKey: "settings.commentPermissions.createOptionCommenter" },
  { level: ROLE.REVIEWER, labelKey: "settings.commentPermissions.createOptionReviewer" },
  { level: ROLE.CONTRIBUTOR, labelKey: "settings.commentPermissions.createOptionContributor" },
  { level: ROLE.PROJECT_LEAD, labelKey: "settings.commentPermissions.createOptionProjectLead" },
  { level: ROLE.MAINTAINER, labelKey: "settings.commentPermissions.createOptionMaintainer" },
]

const COMMENT_RESOLVE_ROLE_OPTIONS: { level: number; labelKey: MessageKey }[] = [
  { level: ROLE.COMMENTER, labelKey: "settings.commentPermissions.resolveOptionCommenter" },
  { level: ROLE.REVIEWER, labelKey: "settings.commentPermissions.resolveOptionReviewer" },
  { level: ROLE.CONTRIBUTOR, labelKey: "settings.commentPermissions.resolveOptionContributor" },
  { level: ROLE.PROJECT_LEAD, labelKey: "settings.commentPermissions.resolveOptionProjectLead" },
  { level: ROLE.MAINTAINER, labelKey: "settings.commentPermissions.resolveOptionMaintainer" },
]

export function CommentPermissionsSection({
  orgSettings,
  canEdit,
}: CommentPermissionsSectionProps) {
  const { t } = useI18n()
  const { commentCreateMinRole, commentResolveMinRole, patch } = orgSettings

  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)

  async function handleCreateChange(newLevel: number) {
    setCreateBusy(true)
    setCreateError(null)
    const result = await patch({ commentCreateMinRole: newLevel })
    if (result.kind === "error") {
      setCreateError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setCreateError("Only org owners can change the comment permission policy.")
    }
    setCreateBusy(false)
  }

  async function handleResolveChange(newLevel: number) {
    setResolveBusy(true)
    setResolveError(null)
    const result = await patch({ commentResolveMinRole: newLevel })
    if (result.kind === "error") {
      setResolveError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setResolveError("Only org owners can change the comment permission policy.")
    }
    setResolveBusy(false)
  }

  return (
    <SettingsGroup
      label={t("settings.commentPermissions.groupLabel")}
      description={t("settings.commentPermissions.groupDescription")}
    >
      <SettingsRow
        label={t("settings.commentPermissions.createLabel")}
        description={t("settings.commentPermissions.createDescription")}
        control={
          <FloorSelect
            id="comment-create-min-role"
            ariaLabel={t("settings.commentPermissions.createLabel")}
            options={COMMENT_CREATE_ROLE_OPTIONS}
            value={commentCreateMinRole}
            disabled={!canEdit || createBusy}
            error={createError}
            onChange={handleCreateChange}
          />
        }
      />
      <SettingsRow
        label={t("settings.commentPermissions.resolveLabel")}
        description={t("settings.commentPermissions.resolveDescription")}
        control={
          <FloorSelect
            id="comment-resolve-min-role"
            ariaLabel={t("settings.commentPermissions.resolveLabel")}
            options={COMMENT_RESOLVE_ROLE_OPTIONS}
            value={commentResolveMinRole}
            disabled={!canEdit || resolveBusy}
            error={resolveError}
            onChange={handleResolveChange}
          />
        }
      />
    </SettingsGroup>
  )
}

function FloorSelect({
  id,
  ariaLabel,
  options,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string
  ariaLabel: string
  options: { level: number; labelKey: MessageKey }[]
  value: number
  disabled: boolean
  error: string | null
  onChange: (level: number) => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex min-w-44 flex-col items-end gap-1">
      <Select
        items={options.map((opt) => ({
          value: String(opt.level),
          label: FLOOR_LABEL[opt.level] ?? t(opt.labelKey),
        }))}
        value={String(value)}
        onValueChange={(v) => { if (v) onChange(Number(v)) }}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label={ariaLabel} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((opt) => (
              <SelectItem key={opt.level} value={String(opt.level)}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error && <FieldError className="text-xs">{error}</FieldError>}
    </div>
  )
}
