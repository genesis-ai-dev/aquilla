/**
 * AQU-427 — Permission-denial affordance helpers.
 *
 * When a gated action fails, the user must see a human-readable explanation —
 * never a silent no-op. This module provides:
 *
 *   - `denialMessage(minRole, currentRole?)` — human-readable "why" string.
 *   - `actionGateProps(canPerform, reason)` — disabled+tooltip props for <button>.
 *
 * Keep this module framework-free (no React) so it can be tested purely and
 * imported from hooks, util files, and components alike.
 */

import { roleName, roleDisplayText } from "@/lib/frontier/roles"

/**
 * Human-readable explanation for why an action is denied.
 *
 * AQU-623 — every denial should speak the permission vocabulary: name the
 * caller's *current* role using the plural role noun ("Viewers cannot perform
 * this action") so the user (or whoever is helping them) immediately sees both
 * who they are and how to remedy it (get a higher role). When the current role
 * is unknown (local projects), fall back to the minimum-role remedy only.
 *
 * @param minRoleLevel  Minimum role level required for the action.
 * @param currentLevel  Caller's current role level (null = unknown / local project).
 * @returns  A string like "Viewers cannot perform this action — you need at
 *           least Contributor access."
 */
export function denialMessage(minRoleLevel: number, currentLevel: number | null | undefined): string {
  const minName = roleDisplayText(roleName(minRoleLevel))
  if (currentLevel == null) {
    return `You need at least ${minName} access to do this.`
  }
  const currentName = roleDisplayText(roleName(currentLevel))
  return `${currentName}s cannot perform this action — you need at least ${minName} access.`
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
