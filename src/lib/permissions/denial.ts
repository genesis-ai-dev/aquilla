/**
 * AQU-427 — Permission-denial affordance helpers.
 *
 * When a gated action fails, the user must see a human-readable explanation —
 * never a silent no-op. This module provides:
 *
 *   - `denialMessage(t, minRole, currentRole?)` — human-readable "why" string.
 *   - `actionGateProps(canPerform, reason)` — disabled+tooltip props for <button>.
 *
 * Keep this module framework-free (no React) so it can be tested purely and
 * imported from hooks, util files, and components alike. `denialMessage`
 * takes a `t()` function as its first argument rather than importing
 * `useT()` itself (AQU-832 wave 3, WS-08) — the sentence is composed from two
 * catalog keys (`common.role.denialUnknown` / `common.role.denialKnown` in
 * `src/lib/i18n/namespaces/common.ts`), so it needs a real translator to
 * render correctly; a test passes a fake `t` to exercise the logic without a
 * `I18nProvider`.
 */

import { roleNameKey, type RoleT } from "@/lib/frontier/roles"

/** @deprecated use `RoleT` from `@/lib/frontier/roles` — kept as an alias so
 *  existing imports don't need to churn. */
export type DenialT = RoleT

/**
 * Human-readable explanation for why an action is denied.
 *
 * AQU-623 — every denial should speak the permission vocabulary: name the
 * caller's *current* role using the plural role noun ("Viewers cannot perform
 * this action") so the user (or whoever is helping them) immediately sees both
 * who they are and how to remedy it (get a higher role). When the current role
 * is unknown (local projects), fall back to the minimum-role remedy only.
 *
 * The plural role noun comes from the catalog's `plural({ one, other })` form
 * (`t(key, { count: 2 })`), never from concatenating "s" onto the singular —
 * that broke every language whose plural isn't "add an s" the moment a
 * non-English locale rendered this message.
 *
 * @param t             Translator, e.g. from `useT()`.
 * @param minRoleLevel  Minimum role level required for the action.
 * @param currentLevel  Caller's current role level (null = unknown / local project).
 * @returns  A string like "Viewers cannot perform this action — you need at
 *           least Contributor access."
 */
export function denialMessage(
  t: DenialT,
  minRoleLevel: number,
  currentLevel: number | null | undefined,
): string {
  const minKey = roleNameKey(minRoleLevel)
  const minName = minKey ? t(minKey, { count: 1 }) : String(minRoleLevel)
  if (currentLevel == null) {
    return t("common.role.denialUnknown", { minRole: minName })
  }
  const currentKey = roleNameKey(currentLevel)
  const currentName = currentKey ? t(currentKey, { count: 2 }) : String(currentLevel)
  return t("common.role.denialKnown", { currentRole: currentName, minRole: minName })
}

/**
 * Props to apply to a <button> (or any element) to communicate a permission
 * denial. Returns `{ disabled: true, tooltip: <reason> }` so the user sees a
 * tooltip on hover and the button is non-interactive.
 *
 * Usage:
 *   <button {...gateProps(canEdit, "contributor")} onClick={handleEdit}>Edit</button>
 *
 * @param allowed   Whether the action is permitted.
 * @param minRole   Human-readable minimum role name (e.g. "contributor").
 * @returns         `{}` when allowed; `{ disabled: true, tooltip: <reason> }` otherwise.
 */
export function actionGateProps(
  allowed: boolean,
  minRoleName: string,
): { disabled?: true; tooltip?: string } {
  if (allowed) return {}
  return {
    disabled: true,
    tooltip: `Requires at least ${minRoleName} access`,
  }
}
