import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { VALIDATION_FLOOR_ROLE_OPTIONS, resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"

type ValidationRoleFloor = NonNullable<ProjectRecord["validationRoleFloor"]>

// AQU-352: the minimum-validator-role floor draws its labels from the canonical
// role source (roles.ts) so they read identically to the member / invite /
// share surfaces — no per-surface role-name drift. The offered set is an
// intentional subset (reviewer and up); subsetting is fine, renaming is not.
// `roleName` (the option's `name`) is exactly the ProjectRecord
// `validationRoleFloor` literal, so it doubles as the stored value.
//
// Built inside the component (not at module scope) because the label needs
// `useT()` — this small (3-item) list is cheap to recompute per render.
function roleOptionsFor(t: ReturnType<typeof useT>): { value: ValidationRoleFloor; label: string }[] {
  return VALIDATION_FLOOR_ROLE_OPTIONS.map((o) => ({
    value: o.name as ValidationRoleFloor,
    label: resolveRoleName(t, o.name),
  }))
}

interface Props {
  validationCount: number
  validationCountAudio: number
  hasAnyAudioData: boolean
  validationRoleFloor?: ValidationRoleFloor
  /** Comma-separated string representation of named users (stored as string[] in ProjectRecord). */
  validationNamedUsers?: string[]
  allowSelfValidation?: boolean
  /** When true, all inputs are disabled (role/offline gate). */
  disabled?: boolean
  /** Tooltip shown on hover when disabled is true. */
  disabledTooltip?: string
  onChange: (
    updates: Partial<
      Pick<
        ProjectRecord,
        | "validationCount"
        | "validationCountAudio"
        | "validationRoleFloor"
        | "validationNamedUsers"
        | "allowSelfValidation"
      >
    >
  ) => void
}

/**
 * Settings card for validation rules.
 * Controls:
 *  - Required validator counts (text / audio)
 *  - Role floor (minimum role that can validate)
 *  - Allow self-validation toggle
 *  - Named-user allowlist (comma-separated text input)
 *
 * Server enforcement of role floor, named-user, and self-validation is
 * deferred — see SWARM-TODOs in src/lib/parsers/types.ts (validationRoleFloor,
 * validationNamedUsers, allowSelfValidation fields).
 */
export function ValidationSettingsSection({
  validationCount,
  validationCountAudio,
  hasAnyAudioData,
  validationRoleFloor = "reviewer",
  validationNamedUsers = [],
  allowSelfValidation = true,
  disabled = false,
  disabledTooltip,
  onChange,
}: Props) {
  const t = useT()
  const ROLE_OPTIONS = roleOptionsFor(t)

  function clamp(raw: string): number {
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n)) return 1
    if (n < 1) return 1
    if (n > 15) return 15
    return n
  }

  /** Convert comma-separated raw string to trimmed username array. */
  function parseNamedUsers(raw: string): string[] {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("projectSettings.section.validation")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Count thresholds ── */}
        <div className="space-y-2">
          <FieldLabel htmlFor="validation-count">{t("projectSettings.validation.requiredTextLabel")}</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Input
              id="validation-count"
              type="number"
              min={1}
              max={15}
              disabled={disabled}
              value={validationCount}
              onChange={(e) => onChange({ validationCount: clamp(e.target.value) })}
              className="w-24"
            />
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.validation.requiredTextDescription")}
          </p>
        </div>
        <div className="space-y-2">
          <FieldLabel htmlFor="validation-count-audio">{t("projectSettings.validation.requiredAudioLabel")}</FieldLabel>
          <DisabledFieldTooltip
            disabled={disabled || !hasAnyAudioData}
            tooltip={disabled ? (disabledTooltip ?? null) : null}
          >
            <Input
              id="validation-count-audio"
              type="number"
              min={1}
              max={15}
              disabled={disabled || !hasAnyAudioData}
              value={validationCountAudio}
              onChange={(e) => onChange({ validationCountAudio: clamp(e.target.value) })}
              className="w-24"
            />
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            {hasAnyAudioData
              ? t("projectSettings.validation.requiredAudioAppliesNote")
              : t("projectSettings.validation.requiredAudioDisabledNote")}
          </p>
        </div>

        {/* ── Role floor ── */}
        <div className="space-y-2">
          <FieldLabel htmlFor="validation-role-floor">{t("projectSettings.validation.minRoleLabel")}</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Select
              items={ROLE_OPTIONS}
              disabled={disabled}
              value={validationRoleFloor}
              onValueChange={(v) =>
                onChange({
                  validationRoleFloor: (v ?? validationRoleFloor) as ValidationRoleFloor,
                })
              }
            >
              <SelectTrigger id="validation-role-floor" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.validation.minRoleDescription")}
            {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch */}
          </p>
        </div>

        {/* ── Allow self-validation ── */}
        <div className="flex items-center gap-3">
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Switch
              id="allow-self-validation"
              disabled={disabled}
              checked={allowSelfValidation}
              onCheckedChange={(checked) => onChange({ allowSelfValidation: checked })}
            />
          </DisabledFieldTooltip>
          <div className="space-y-0.5">
            <FieldLabel htmlFor="allow-self-validation">{t("projectSettings.validation.allowSelfLabel")}</FieldLabel>
            <p className="text-xs text-muted-foreground">
              {t("projectSettings.validation.allowSelfDescription")}
              {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch */}
            </p>
          </div>
        </div>

        {/* ── Named-user allowlist ── */}
        <div className="space-y-2">
          <FieldLabel htmlFor="validation-named-users">{t("projectSettings.validation.namedValidatorsLabel")}</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Input
              id="validation-named-users"
              type="text"
              disabled={disabled}
              placeholder={t("projectSettings.validation.namedValidatorsPlaceholder")}
              value={validationNamedUsers.join(", ")}
              onChange={(e) =>
                onChange({ validationNamedUsers: parseNamedUsers(e.target.value) })
              }
              className="w-72"
            />
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.validation.namedValidatorsDescription")}
            {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch.
                Full typeahead (UsernameTypeahead) would improve UX — blocked on integrating
                the component here while keeping Props lightweight. */}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
