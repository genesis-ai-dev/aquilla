import type { ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { OptionalMark } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { MemberMultiSelect } from "@/components/MemberMultiSelect"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { useProjectMembers } from "@/hooks/useProjectMembers"
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
  /** Project id for loading member usernames into the named-validators combobox. */
  projectId?: string | null
  validationCount: number
  validationCountAudio: number
  validationRoleFloor?: ValidationRoleFloor
  /** Named-user allowlist (usernames). Empty = any sufficiently-privileged user. */
  validationNamedUsers?: string[]
  allowSelfValidation?: boolean
  /**
   * AQU-490: the audio policy. SEPARATE keys, never fallbacks for the text
   * ones — a project can want two ears on a recording and one on a
   * translation, or trust a different set of people with each.
   */
  validationRoleFloorAudio?: ValidationRoleFloor
  validationNamedUsersAudio?: string[]
  allowSelfValidationAudio?: boolean
  /** When true, all inputs are disabled (role/offline gate). */
  disabled?: boolean
  /**
   * AQU-1083: the "do headings count toward progress" row, rendered as the
   * last row of this card.
   *
   * A slot rather than more props, because unlike everything else here that
   * control is NOT part of the page's draft/baseline state — it patches the
   * shared settings blob directly (see its own note for why it has to). Taking
   * it as a node keeps this component the pure, fully-controlled section it
   * has always been.
   */
  structuralCellsRow?: ReactNode
  /** Tooltip shown on hover when disabled is true. */
  disabledTooltip?: ReactNode
  onChange: (
    updates: Partial<
      Pick<
        ProjectRecord,
        | "validationCount"
        | "validationCountAudio"
        | "validationRoleFloor"
        | "validationNamedUsers"
        | "allowSelfValidation"
        | "validationRoleFloorAudio"
        | "validationNamedUsersAudio"
        | "allowSelfValidationAudio"
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
 *  - Named-user allowlist (MemberMultiSelect over project members)
 *
 * Server enforcement of role floor, named-user, and self-validation is
 * deferred — see SWARM-TODOs in src/lib/parsers/types.ts (validationRoleFloor,
 * validationNamedUsers, allowSelfValidation fields).
 */
export function ValidationSettingsSection({
  projectId = null,
  validationCount,
  validationCountAudio,
  validationRoleFloor = "reviewer",
  validationNamedUsers = [],
  allowSelfValidation = true,
  validationRoleFloorAudio = "reviewer",
  validationNamedUsersAudio = [],
  allowSelfValidationAudio = true,
  disabled = false,
  disabledTooltip,
  structuralCellsRow,
  onChange,
}: Props) {
  const t = useT()
  const ROLE_OPTIONS = roleOptionsFor(t)
  const { members } = useProjectMembers(projectId)

  // Offer project members, and keep any already-saved names that left the roster
  // so they remain selectable / visible in the trigger.
  const namedUserItems = Array.from(
    new Set([
      ...members.map((m) => m.username),
      ...validationNamedUsers,
    ]),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))

  function clamp(raw: string): number {
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n)) return 1
    if (n < 1) return 1
    if (n > 15) return 15
    return n
  }

  return (
    <SettingsGroup label={t("projectSettings.section.validation")}>
      <SettingsRow
        label={<label htmlFor="validation-count">{t("projectSettings.validation.requiredTextLabel")}</label>}
        description={t("projectSettings.validation.requiredTextDescription")}
        control={
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Input
              id="validation-count"
              type="number"
              min={1}
              max={15}
              disabled={disabled}
              value={validationCount}
              onChange={(e) => onChange({ validationCount: clamp(e.target.value) })}
              className="w-24 bg-background"
              aria-label={t("projectSettings.validation.requiredTextLabel")}
            />
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={<label htmlFor="validation-count-audio">{t("projectSettings.validation.requiredAudioLabel")}</label>}
        description={t("projectSettings.validation.requiredAudioAppliesNote")}
        control={
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Input
              id="validation-count-audio"
              type="number"
              min={1}
              max={15}
              // AQU-490: never gated on "audio exists". That gate read a
              // device-local latch and locked a fully dubbed project's
              // threshold on any browser that had not itself recorded; the
              // number is a policy the projection applies at read time and
              // is harmless to set before the first take.
              disabled={disabled}
              value={validationCountAudio}
              onChange={(e) => onChange({ validationCountAudio: clamp(e.target.value) })}
              className="w-24 bg-background"
              aria-label={t("projectSettings.validation.requiredAudioLabel")}
            />
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={<label htmlFor="validation-role-floor">{t("projectSettings.validation.minRoleLabel")}</label>}
        description={t("projectSettings.validation.minRoleDescription")}
        control={
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
              <SelectTrigger
                id="validation-role-floor"
                className="w-48 bg-background"
                aria-label={t("projectSettings.validation.minRoleLabel")}
              >
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
        }
      />
      <SettingsRow
        label={<label htmlFor="allow-self-validation">{t("projectSettings.validation.allowSelfLabel")}</label>}
        description={t("projectSettings.validation.allowSelfDescription")}
        control={
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Switch
              id="allow-self-validation"
              disabled={disabled}
              checked={allowSelfValidation}
              onCheckedChange={(checked) => onChange({ allowSelfValidation: checked })}
              aria-label={t("projectSettings.validation.allowSelfLabel")}
            />
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={
          <label htmlFor="validation-named-users">
            {t("projectSettings.validation.namedValidatorsLabel")} <OptionalMark />
          </label>
        }
        description={t("projectSettings.validation.namedValidatorsDescription")}
        block
      >
        <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
          <MemberMultiSelect
            id="validation-named-users"
            members={namedUserItems}
            value={validationNamedUsers}
            disabled={disabled}
            placeholder={t("projectSettings.validation.namedValidatorsPlaceholder")}
            aria-label={t("projectSettings.validation.namedValidatorsLabel")}
            onValueChange={(next) => onChange({ validationNamedUsers: next })}
          />
        </DisabledFieldTooltip>
      </SettingsRow>
      {/* AQU-490: the audio policy, beside the text policy rather than folded
          into it. Sam's ruling is that these are SEPARATE settings — a
          project can want two ears on a recording and one on a translation,
          or trust a different set of people with each — so the surface has to
          make the separation visible rather than imply a shared rule. */}
      <SettingsRow
        label={<label htmlFor="validation-role-floor-audio">{t("projectSettings.validation.minRoleAudioLabel")}</label>}
        description={t("projectSettings.validation.minRoleAudioDescription")}
        control={
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Select
              items={ROLE_OPTIONS}
              disabled={disabled}
              value={validationRoleFloorAudio}
              onValueChange={(v) =>
                onChange({
                  validationRoleFloorAudio: (v ?? validationRoleFloorAudio) as ValidationRoleFloor,
                })
              }
            >
              <SelectTrigger
                id="validation-role-floor-audio"
                className="w-48 bg-background"
                aria-label={t("projectSettings.validation.minRoleAudioLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={`audio-${o.value}`} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={<label htmlFor="allow-self-validation-audio">{t("projectSettings.validation.allowSelfAudioLabel")}</label>}
        description={t("projectSettings.validation.allowSelfAudioDescription")}
        control={
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Switch
              id="allow-self-validation-audio"
              disabled={disabled}
              checked={allowSelfValidationAudio}
              onCheckedChange={(checked) => onChange({ allowSelfValidationAudio: checked })}
              aria-label={t("projectSettings.validation.allowSelfAudioLabel")}
            />
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={
          <label htmlFor="validation-named-users-audio">
            {t("projectSettings.validation.namedValidatorsAudioLabel")} <OptionalMark />
          </label>
        }
        description={t("projectSettings.validation.namedValidatorsAudioDescription")}
        block
      >
        <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
          <MemberMultiSelect
            id="validation-named-users-audio"
            members={namedUserItems}
            value={validationNamedUsersAudio}
            disabled={disabled}
            placeholder={t("projectSettings.validation.namedValidatorsPlaceholder")}
            aria-label={t("projectSettings.validation.namedValidatorsAudioLabel")}
            onValueChange={(next) => onChange({ validationNamedUsersAudio: next })}
          />
        </DisabledFieldTooltip>
      </SettingsRow>
      {structuralCellsRow}
    </SettingsGroup>
  )
}
