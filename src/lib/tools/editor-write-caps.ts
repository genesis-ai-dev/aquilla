/**
 * Smart Extensions: whether an extension editor may write the active lane.
 * Handed to the frame as `canEdit` / `canValidate` in the editor config.
 *
 * Mirrors EditorTable's capabilities (useEditorCapabilities): an archived
 * active lane (AQU-1463) freezes target edits AND validation for every role,
 * because the sync-worker refuses any write naming it (AQU-1462). A read-only
 * project (git/local permissions) stops target edits only, as before.
 */

import { canPerform } from "@/lib/sync/role-policy"

export interface ExtensionEditorWriteCapsInput {
  /** The whole project is read-only for this user (git/local permissions). */
  projectReadOnly: boolean
  /** The lane the editor is pointed at has been archived. */
  laneArchived: boolean
  /** The user's project role level (null for a local project). */
  roleLevel: number | null
}

export function extensionEditorWriteCaps(input: ExtensionEditorWriteCapsInput): { canEdit: boolean; canValidate: boolean } {
  const { projectReadOnly, laneArchived, roleLevel } = input
  return {
    canEdit: !projectReadOnly && !laneArchived && canPerform("target.cell.commit", roleLevel),
    canValidate: !laneArchived && canPerform("cell.validate", roleLevel),
  }
}
