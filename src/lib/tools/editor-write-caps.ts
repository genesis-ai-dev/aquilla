/**
 * Smart Extensions: whether an extension editor may write the active lane,
 * and the read-only banner it shows. Handed to the frame in the editor config
 * (`canEdit`, `canValidate`, apiRev 5 `readOnlyLabel` / `readOnlyKind`).
 *
 * Mirrors EditorTable: an archived active lane (AQU-1463) freezes target edits
 * AND validation for every role, because the sync-worker refuses any write
 * naming it (AQU-1462); a read-only project stops target edits only. The
 * banner is the built-in's own: resolveEditorCapabilities' label (archived
 * lane, imported project, reviewer/commenter/viewer), with EditorTable's
 * AQU-1571 reviewer refinement.
 */

import { canPerform } from "@/lib/sync/role-policy"
import { resolveEditorCapabilities } from "@/hooks/useProjectPermissions"
import { textValidationScope } from "@/lib/review/text-validation-policy"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"

export interface ExtensionEditorWriteCapsInput {
  /** The whole project is read-only for this user (imported/local permissions). */
  projectReadOnly: boolean
  /** The lane the editor is pointed at has been archived. */
  laneArchived: boolean
  /** The user's project role level (null for a local project). */
  roleLevel: number | null
  /** AQU-1902: the active lane's row is not known yet ("Loading languages…"). */
  lanesPending?: boolean
}

export function extensionEditorWriteCaps(input: ExtensionEditorWriteCapsInput): { canEdit: boolean; canValidate: boolean } {
  const { projectReadOnly, laneArchived, roleLevel, lanesPending = false } = input
  return {
    canEdit: !projectReadOnly && !laneArchived && !lanesPending && canPerform("target.cell.commit", roleLevel),
    canValidate: !laneArchived && !lanesPending && canPerform("cell.validate", roleLevel),
  }
}

/** The built-in editor's read-only banner for this reader (null: none). */
export function extensionEditorReadOnlyBanner(opts: {
  project: ProjectRecord
  /** The archived active lane's label (AQU-1463), else null. */
  archivedLaneLabel: string | null
  username: string
  t: TFunction
}): { readOnlyLabel: string | null; readOnlyKind: "lane-archived" | "role" | null } {
  const { project, archivedLaneLabel, username, t } = opts
  const caps = resolveEditorCapabilities(project, { archivedLaneLabel })
  if (!caps.readOnlyLabel) return { readOnlyLabel: null, readOnlyKind: null }
  const label = !caps.canEdit && caps.canValidate
    && !textValidationScope(project, { roleLevel: project.syncRole?.level ?? null, username }).canValidate
    ? t("editor.readOnly.reviewerNoTextValidation")
    : caps.readOnlyLabel
  return { readOnlyLabel: label, readOnlyKind: archivedLaneLabel !== null ? "lane-archived" : "role" }
}
