import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RoleLabel } from "@/components/RoleLabel"
import { resolveRoleName, roleDescription, roleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export type RoleSelectOption = {
  level: number
  name: string
  description?: string
}

export interface RoleSelectProps {
  value: number | null | undefined
  onValueChange: (level: number) => void
  /**
   * Roles offered in the menu. Required: each door passes its level's list
   * from `roleChoices()` (AQU-2289), so no picker can fall back to all seven.
   */
  options: readonly RoleSelectOption[]
  /**
   * When the current value sits outside `options` (e.g. Owner above a
   * grantable cap), include it so the closed trigger still shows a name.
   */
  currentOption?: RoleSelectOption | null
  size?: "sm" | "default"
  disabled?: boolean
  id?: string
  "aria-label"?: string
  className?: string
  contentClassName?: string
}

function resolveOption(opt: RoleSelectOption): Required<RoleSelectOption> {
  return {
    level: opt.level,
    name: opt.name || roleName(opt.level),
    description: opt.description ?? roleDescription(opt.level),
  }
}

/**
 * Role-only Select: each option shows the role name plus its AD-6 capability
 * blurb. Use this anywhere a role is chosen or changed — not for unrelated
 * selects (validation floors with custom labels, roster visibility, etc.).
 */
export function RoleSelect({
  value,
  onValueChange,
  options,
  currentOption = null,
  size = "default",
  disabled,
  id,
  "aria-label": ariaLabel,
  className,
  contentClassName,
}: RoleSelectProps) {
  const t = useT()
  const resolved = options.map(resolveOption)
  const valueStr = value != null ? String(value) : ""
  const valueInOptions = resolved.some((o) => o.level === value)
  const extra =
    currentOption && !valueInOptions && currentOption.level === value
      ? resolveOption(currentOption)
      : null

  // The closed trigger shows these labels: the catalog's name, so it reads
  // in sentence case and in the reader's language, like the open list.
  const items = [
    ...(extra
      ? [{ value: String(extra.level), label: resolveRoleName(t, extra.name) }]
      : []),
    ...resolved.map((o) => ({
      value: String(o.level),
      label: resolveRoleName(t, o.name),
    })),
  ]

  return (
    <Select
      items={items}
      value={valueStr}
      onValueChange={(v) => {
        if (v == null || v === "") return
        onValueChange(Number(v))
      }}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        className={className}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="start"
        className={cn("min-w-72 max-w-96", contentClassName)}
      >
        <SelectGroup>
          {resolved.map((o) => (
            <SelectItem key={o.level} value={String(o.level)} multiline>
              <span className="flex min-w-0 flex-col gap-0.5">
                <RoleLabel name={o.name} plain className="font-medium normal-case" />
                {o.description ? (
                  <span className="text-xs font-normal whitespace-normal text-muted-foreground normal-case">
                    {o.description}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/** Build a RoleSelectOption from a numeric level when only the level is known. */
export function roleSelectOptionFromLevel(level: number): RoleSelectOption {
  return { level, name: roleName(level), description: roleDescription(level) }
}
