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
        <CardTitle>Validation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Count thresholds ── */}
        <div className="space-y-2">
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
        <div className="space-y-2">
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
        <div className="space-y-2">
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
          <div className="space-y-0.5">
            <FieldLabel htmlFor="allow-self-validation">Allow self-validation</FieldLabel>
            <p className="text-xs text-muted-foreground">
              When off, a contributor's vote on their own commit is ignored.
              {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch */}
            </p>
          </div>
        </div>

        {/* ── Named-user allowlist ── */}
        <div className="space-y-2">
          <FieldLabel htmlFor="validation-named-users">Named validators (optional)</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Input
              id="validation-named-users"
              type="text"
              disabled={disabled}
              placeholder="alice, bob, carol"
              value={validationNamedUsers.join(", ")}
              onChange={(e) =>
                onChange({ validationNamedUsers: parseNamedUsers(e.target.value) })
              }
              className="w-72"
            />
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            Comma-separated usernames. When set, only these users' votes count toward the
            threshold (AND'd with the role floor). Leave empty to allow any sufficiently-
            privileged user.
            {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch.
                Full typeahead (UsernameTypeahead) would improve UX — blocked on integrating
                the component here while keeping Props lightweight. */}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
