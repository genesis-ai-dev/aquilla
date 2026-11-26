/** AQU-2321: why a role pill or an × on the Places lens is not editable, in words. */
import { roleLabel } from "@/components/access/labels"
import type { RowEdit, RowRemoval } from "@/lib/access/edit-access"
import type { TFunction } from "@/lib/i18n/I18nProvider"

type Reason = Exclude<RowEdit, { ok: true }>["reason"] | Exclude<RowRemoval, { ok: true }>["reason"]

/** `cap` is the viewer's own role there, named when the reason is that the person outranks them. */
export function editDeniedText(t: TFunction, reason: Reason, cap: number | null): string {
  return t(`org.access.edit.denied.${reason}`, { cap: roleLabel(t, cap) })
}
