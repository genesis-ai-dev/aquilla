import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox"
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
 *  - Named-user allowlist (multi-select combobox of project members)
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
  const namedUsersAnchor = useComboboxAnchor()

  // Offer project members, and keep any already-saved names that left the roster
  // so chips remain removable / visible.
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
    <Card>
      <CardHeader>
        <CardTitle>Validation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* ── Count thresholds ── */}
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="validation-count">Required validators (text)</FieldLabel>
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
            Cells need this many distinct validators to count as fully validated.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="validation-count-audio">Required validators (audio)</FieldLabel>
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
              ? "Applies to audio translations."
              : "Enabled once audio translations exist."}
          </p>
        </div>

        {/* ── Role floor ── */}
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="validation-role-floor">Minimum validator role</FieldLabel>
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
            Only users with at least this role can cast a validation vote. Defaults to reviewer.
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
          <div className="flex flex-col gap-0.5">
            <FieldLabel htmlFor="allow-self-validation">Allow self-validation</FieldLabel>
            <p className="text-xs text-muted-foreground">
              When off, a contributor's vote on their own commit is ignored.
              {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch */}
            </p>
          </div>
        </div>

        {/* ── Named-user allowlist ── */}
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor="validation-named-users">Named validators (optional)</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Combobox
              multiple
              autoHighlight
              disabled={disabled}
              items={namedUserItems}
              value={validationNamedUsers}
              onValueChange={(next) => {
                onChange({
                  validationNamedUsers: Array.isArray(next)
                    ? next.filter((u): u is string => typeof u === "string")
                    : [],
                })
              }}
            >
              <ComboboxChips ref={namedUsersAnchor} className="w-full max-w-md">
                <ComboboxValue>
                  {validationNamedUsers.map((username) => (
                    <ComboboxChip key={username}>{username}</ComboboxChip>
                  ))}
                </ComboboxValue>
                <ComboboxChipsInput
                  id="validation-named-users"
                  disabled={disabled}
                  placeholder={
                    validationNamedUsers.length === 0
                      ? "Select project members…"
                      : undefined
                  }
                />
              </ComboboxChips>
              <ComboboxContent anchor={namedUsersAnchor}>
                <ComboboxEmpty>No members found.</ComboboxEmpty>
                <ComboboxList>
                  {(item) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </DisabledFieldTooltip>
          <FieldDescription>
            When set, only these users&apos; votes count toward the threshold (AND&apos;d with
            the role floor). Leave empty to allow any sufficiently-privileged user.
            {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch. */}
          </FieldDescription>
        </Field>
      </CardContent>
    </Card>
  )
}
