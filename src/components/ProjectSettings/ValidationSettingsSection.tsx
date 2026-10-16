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

/** AQU-1771: the counts may be null, meaning "use the organization's default". */
type CountUpdates = { validationCount?: number | null; validationCountAudio?: number | null }

interface Props {
  /** Project id for loading member usernames into the named-validators combobox. */
  projectId?: string | null
  /**
   * AQU-1771: the project's OWN numbers. Null means it has none and takes the
   * organization's default (`orgValidationCount`, then 1).
   */
  validationCount: number | null
  validationCountAudio: number | null
  /** AQU-1771: what "Organization default" currently resolves to. Null = the org set none (1). */
  orgValidationCount?: number | null
  orgValidationCountAudio?: number | null
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
  /**
   * AQU-1391: the repetition auto-propagation control. Same slot treatment and
   * the same reason as `structuralCellsRow` above — it patches the shared
   * settings blob directly rather than riding this page's draft/baseline
   * state. It belongs in THIS card because validation is the gesture that
   * triggers it.
   */
  repetitionPropagationRow?: ReactNode
  /** Tooltip shown on hover when disabled is true. */
  disabledTooltip?: ReactNode
  /**
   * AQU-1075: "from <upstream>" plus Detach when workflow policy is still
   * being copied. Rendered above the text group.
   */
  notice?: ReactNode
  onChange: (
    updates: CountUpdates & Partial<
      Pick<
        ProjectRecord,
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
  orgValidationCount = null,
  orgValidationCountAudio = null,
  validationRoleFloor = "reviewer",
  validationNamedUsers = [],
  allowSelfValidation = true,
  validationRoleFloorAudio = "reviewer",
  validationNamedUsersAudio = [],
  allowSelfValidationAudio = true,
  disabled = false,
  disabledTooltip,
  notice,
  structuralCellsRow,
  repetitionPropagationRow,
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

  // AQU-1771: "Organization default (N)" or this project's own number, then
  // the number itself when it is the project's own. Picking the default clears
  // the project's value; picking "Set for this project" starts from the number
  // in force, so nothing changes until the user edits it.
  function countControl(opts: {
    id: string
    label: string
    sourceAria: string
    value: number | null
    orgValue: number | null
    emit: (next: number | null) => void
  }) {
    const sourceItems = [
      { value: "inherit", label: t("projectSettings.validation.orgDefaultOption", { number: opts.orgValue ?? 1 }) },
      { value: "custom", label: t("projectSettings.validation.customOption") },
    ]
    const source = opts.value == null ? "inherit" : "custom"
    return (
      <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
        <div className="flex items-center gap-2">
          <Select
            items={sourceItems}
            disabled={disabled}
            value={source}
            onValueChange={(v) => {
              if (v === source) return
              opts.emit(v === "inherit" ? null : (opts.orgValue ?? 1))
            }}
          >
            <SelectTrigger
              id={`${opts.id}-source`}
              className="w-56 bg-background"
              aria-label={opts.sourceAria}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sourceItems.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {opts.value != null && (
            <Input
              id={opts.id}
              type="number"
              min={1}
              max={15}
              disabled={disabled}
              value={opts.value}
              onChange={(e) => opts.emit(clamp(e.target.value))}
              className="w-20 bg-background"
              aria-label={opts.label}
            />
          )}
        </div>
      </DisabledFieldTooltip>
    )
  }

  return (
    <>
      {notice}
      <SettingsGroup label={t("projectSettings.validation.textGroup")}>
        <SettingsRow
          // AQU-1771: while inheriting there is no number box, so the label names
          // the "Organization default" select instead.
          label={<label htmlFor={validationCount == null ? "validation-count-source" : "validation-count"}>{t("projectSettings.validation.requiredTextLabel")}</label>}
          description={t("projectSettings.validation.requiredTextDescription")}
          control={countControl({
            id: "validation-count",
            label: t("projectSettings.validation.requiredTextLabel"),
            sourceAria: t("projectSettings.validation.requiredTextSourceAria"),
            value: validationCount,
            orgValue: orgValidationCount,
            emit: (next) => onChange({ validationCount: next }),
          })}
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
        {/* Both slot rows are about text: whether headings count toward its
            progress, and whether a validated translation spreads to repeats. */}
        {structuralCellsRow}
        {repetitionPropagationRow}
      </SettingsGroup>
      {/* AQU-490: the audio policy, beside the text policy rather than folded
          into it. Sam's ruling is that these are SEPARATE settings — a
          project can want two ears on a recording and one on a translation,
          or trust a different set of people with each. Since 2026-10-03 each
          has its own card: one card mixing the two read as one muddled rule
          (Sam, PR 1 test pass). */}
      <SettingsGroup label={t("projectSettings.validation.audioGroup")}>
        <SettingsRow
          label={<label htmlFor={validationCountAudio == null ? "validation-count-audio-source" : "validation-count-audio"}>{t("projectSettings.validation.requiredAudioLabel")}</label>}
          description={t("projectSettings.validation.requiredAudioAppliesNote")}
          // AQU-490: never gated on "audio exists". That gate read a
          // device-local latch and locked a fully dubbed project's threshold
          // on any browser that had not itself recorded; the number is a
          // policy the projection applies at read time and is harmless to
          // set before the first take.
          control={countControl({
            id: "validation-count-audio",
            label: t("projectSettings.validation.requiredAudioLabel"),
            sourceAria: t("projectSettings.validation.requiredAudioSourceAria"),
            value: validationCountAudio,
            orgValue: orgValidationCountAudio,
            emit: (next) => onChange({ validationCountAudio: next }),
          })}
        />
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
      </SettingsGroup>
    </>
  )
}
