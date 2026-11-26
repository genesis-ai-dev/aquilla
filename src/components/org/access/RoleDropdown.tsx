/**
 * AQU-2321: the solid role pill on a direct grant, as a dropdown. It offers
 * the rungs valid at that kind of place, none above the viewer's own role
 * there (grant-rules.ts roleChangeOptions — the rule the routes apply), and
 * writes the change through the route that owns the row. The pill shows the
 * new role at once; `onChanged` lets the page re-read the lens behind it.
 *
 * Exported on its own: the person inspector's grant cards (AQU-2323) put the
 * same control on each grant.
 */
import { useState } from "react"
import { ChevronDown, Pencil } from "lucide-react"

import { roleLabel } from "@/components/access/labels"
import { RoleBadge } from "@/components/access/RoleBadge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { rowGrant, type RowEdit } from "@/lib/access/edit-access"
import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin, ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"

import { changeGrantRole } from "./edit-access-data"
import { editDeniedText } from "./edit-access-text"

export interface RoleDropdownProps {
  orgId: number
  /** The place the grant is set at, and its path (outermost first) for the confirmation. */
  place: ScopeRef
  path: ScopeRef[]
  person: { userId: string; displayName: string; username: string | null }
  roleLevel: number
  origin?: GrantOrigin
  /** AQU-2322: a project row that is lane grants names them on the pill. */
  lanes?: readonly string[]
  /** From rowEdit(): the roles to offer, or why this pill is not a dropdown. */
  edit: RowEdit
  /** After the write succeeded. */
  onChanged?: (roleLevel: number) => void
}


export function RoleDropdown({ orgId, place, path, person, roleLevel, origin = { kind: "direct" }, lanes, edit, onChanged }: RoleDropdownProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  // The chosen role, shown until the re-read lens says otherwise.
  const [override, setOverride] = useState<{ from: number; to: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const shown = override && override.from === roleLevel ? override.to : roleLevel
  const grant = rowGrant(place)

  if (!edit.ok) {
    return (
      <AppTooltip content={editDeniedText(t, edit.reason, edit.cap)}>
        <span data-testid="role-static" data-reason={edit.reason} className="inline-flex">
          <RoleBadge roleLevel={roleLevel} origin={origin} lanes={lanes} />
        </span>
      </AppTooltip>
    )
  }

  const choose = async (next: number) => {
    if (!jwt || saving || next === shown) return
    const before = shown
    setOverride({ from: roleLevel, to: next })
    setSaving(true)
    try {
      await changeGrantRole(jwt, orgId, person, grant, next)
      toast.add({ type: "success", title: t("org.access.edit.roleChanged", { name: person.displayName, role: roleLabel(t, next), path: formatScopePath(path) }) })
      onChanged?.(next)
    } catch {
      setOverride(before === roleLevel ? null : { from: roleLevel, to: before })
      toast.add({ type: "error", title: t("org.access.edit.roleError") })
    } finally {
      setSaving(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={saving}
            aria-label={t("org.access.edit.changeRole", { name: person.displayName })}
            data-testid="role-dropdown"
            className="inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <RoleBadge roleLevel={shown} origin={origin} />
        <Pencil className="size-3 text-muted-foreground" aria-hidden />
        <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup value={String(shown)} onValueChange={(value) => void choose(Number(value))}>
          {edit.roles.map((level) => (
            <DropdownMenuRadioItem key={level} value={String(level)} closeOnClick data-testid="role-option" data-role-level={level}>
              {roleLabel(t, level)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
