import { Input } from "@/components/ui/input"
import { FieldDescription, OptionalMark } from "@/components/ui/field"
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
import { VALIDATION_FLOOR_ROLE_OPTIONS, roleDisplayText } from "@/lib/frontier/roles"
import type { ProjectRecord } from "@/lib/parsers/types"

type ValidationRoleFloor = NonNullable<ProjectRecord["validationRoleFloor"]>

// AQU-352: the minimum-validator-role floor draws its labels from the canonical
// role source (roles.ts) so they read identically to the member / invite /
// share surfaces — no per-surface role-name drift. The offered set is an
// intentional subset (reviewer and up); subsetting is fine, renaming is not.
// `roleName` (the option's `name`) is exactly the ProjectRecord
// `validationRoleFloor` literal, so it doubles as the stored value.
const ROLE_OPTIONS: { value: ValidationRoleFloor; label: string }[] =
  VALIDATION_FLOOR_ROLE_OPTIONS.map((o) => ({
    value: o.name as ValidationRoleFloor,
    label: roleDisplayText(o.name),
  }))

interface Props {
  /** Project id for loading member usernames into the named-validators combobox. */
  projectId?: string | null
  validationCount: number
  validationCountAudio: number
  hasAnyAudioData: boolean
  validationRoleFloor?: ValidationRoleFloor
  /** Named-user allowlist (usernames). Empty = any sufficiently-privileged user. */
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
  hasAnyAudioData,
  validationRoleFloor = "reviewer",
  validationNamedUsers = [],
  allowSelfValidation = true,
  disabled = false,
  disabledTooltip,
  onChange,
}: Props) {
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
    <SettingsGroup label="Validation">
      <SettingsRow
        label={<label htmlFor="validation-count">Required validators (text)</label>}
        description="Cells need this many distinct validators to count as fully validated."
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
              aria-label="Required validators (text)"
            />
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={<label htmlFor="validation-count-audio">Required validators (audio)</label>}
        description={
          hasAnyAudioData
            ? "Applies to audio translations."
            : "Enabled once audio translations exist."
        }
        control={
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
              className="w-24 bg-background"
              aria-label="Required validators (audio)"
            />
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={<label htmlFor="validation-role-floor">Minimum validator role</label>}
        description="Only users with at least this role can cast a validation vote. Defaults to reviewer."
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
                aria-label="Minimum validator role"
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
        label={<label htmlFor="allow-self-validation">Allow self-validation</label>}
        description="When off, a contributor's vote on their own commit is ignored."
        control={
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Switch
              id="allow-self-validation"
              disabled={disabled}
              checked={allowSelfValidation}
              onCheckedChange={(checked) => onChange({ allowSelfValidation: checked })}
              aria-label="Allow self-validation"
            />
          </DisabledFieldTooltip>
        }
      />
      <SettingsRow
        label={
          <label htmlFor="validation-named-users">
            Named validators <OptionalMark />
          </label>
        }
        description={
          <>
            When set, only these users&apos; votes count toward the threshold (AND&apos;d with
            the role floor). Leave empty to allow any sufficiently-privileged user.
          </>
        }
        block
      >
        <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
          <MemberMultiSelect
            id="validation-named-users"
            members={namedUserItems}
            value={validationNamedUsers}
            disabled={disabled}
            placeholder="Select project members…"
            aria-label="Named validators"
            onValueChange={(next) => onChange({ validationNamedUsers: next })}
          />
        </DisabledFieldTooltip>
        {disabled ? (
          <FieldDescription className="mt-2">{disabledTooltip}</FieldDescription>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  )
}
