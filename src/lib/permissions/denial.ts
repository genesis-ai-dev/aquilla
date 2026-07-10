/**
 * FRO-427 — Permission-denial affordance helpers.
 *
 * When a gated action fails, the user must see a human-readable explanation —
 * never a silent no-op. This module provides:
 *
 *   - `denialMessage(minRole, currentRole?)` — human-readable "why" string.
 *   - `actionGateProps(canPerform, reason)` — disabled+title props for <button>.
 *
 * Keep this module framework-free (no React) so it can be tested purely and
 * imported from hooks, util files, and components alike.
 */

import { roleName, roleDisplayText } from "@/lib/frontier/roles"

/**
 * Human-readable explanation for why an action is denied.
 *
 * @param minRoleLevel  Minimum role level required for the action.
 * @param currentLevel  Caller's current role level (null = unknown / local project).
 * @returns  A string like "You need at least contributor access to do this."
 */
export function denialMessage(minRoleLevel: number, currentLevel: number | null | undefined): string {
  const minName = roleDisplayText(roleName(minRoleLevel))
  if (currentLevel == null) {
    return `You need at least ${minName} access to do this.`
  }
  const currentName = roleDisplayText(roleName(currentLevel))
  return `Your current role (${currentName}) does not have permission to do this. At least ${minName} is required.`
}

/**
 * Props to apply to a <button> (or any element) to communicate a permission
 * denial. Returns `{ disabled: true, title: <reason> }` so the user sees a
 * tooltip on hover and the button is non-interactive.
 *
 * Usage:
 *   <button {...gateProps(canEdit, "contributor")} onClick={handleEdit}>Edit</button>
 *
 * @param allowed   Whether the action is permitted.
 * @param minRole   Human-readable minimum role name (e.g. "contributor").
 * @returns         `{}` when allowed; `{ disabled: true, title: <reason> }` otherwise.
 */
export function actionGateProps(
  allowed: boolean,
  minRoleName: string,
): { disabled?: true; title?: string } {
  if (allowed) return {}
  return {
    disabled: true,
    title: `Requires at least ${minRoleName} access`,
  }
}
