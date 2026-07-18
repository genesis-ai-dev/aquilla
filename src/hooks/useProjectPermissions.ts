import { useMemo } from "react";
import type { ProjectRecord, ProjectPermissions } from "@/lib/parsers/types";
import { ROLE } from "@/lib/frontier/roles";

export const defaultLocalPermissions: ProjectPermissions = {
  source: "local",
  canEditContent: true,
  canEditComments: true,
  canResolveComments: true,
  canPush: false,
};

/**
 * Numeric role level → editor capability flags.
 *
 * For cloud projects (syncRole present, permissions absent) we derive
 * canEditContent directly from the live numeric role level:
 *   - CONTRIBUTOR (400) and up → full editing
 *   - REVIEWER (300) → validate only, no content edits
 *   - COMMENTER / VIEWER (≤ 200) → read-only
 *
 * For local/git projects we keep the existing permissions object as-is.
 */
export interface EditorCapabilities {
  /** Whether the user may edit cell content (target.cell.commit path). */
  canEdit: boolean
  /** Whether the user may cast validation votes (cell.validate path). */
  canValidate: boolean
  /**
   * Whether the user may edit SOURCE cell text (source.cell.commit path) —
   * e.g. a template owner fixing an English line that propagates to downstream
   * linked projects. Gated at the sync-worker source.cell.commit floor
   * (PROJECT_LEAD, 500) and suppressed on live-linked downstreams, whose
   * mirrored source lane is read-only (the lock is server-enforced; the client
   * only surfaces the affordance where editing is actually permitted, i.e.
   * self-contained / template / source-only / clone-linked projects).
   *
   * Cloud-only: local/git projects (no syncRole) never expose it — the feature
   * targets the cloud linked-projects workflow.
   *
   * NOTE (v1 scope): a live-linked downstream MAY hold downstream-added local
   * source cells (no upstream_event_id) that the spec allows editing, but the
   * client cell read-model doesn't yet carry per-cell upstream provenance, so
   * the whole affordance is gated off for live projects. The server stays
   * authoritative (409 on locked cells) regardless.
   */
  canEditSource: boolean
  /**
   * Human-readable role label for the read-only badge.
   * Null when the user has full edit access (no badge shown).
   */
  readOnlyLabel: string | null
  /**
   * SOURCE-side read-only explanation. Non-null when canEditSource is forced
   * off for a reason unrelated to role (today: the project is pinned to a DCS
   * upstream, so the repair path would overwrite any hand-edit). Null when the
   * source lane is editable or merely role-gated.
   */
  sourceReadOnlyReason: string | null
}

/** Shown wherever the source-edit affordance is suppressed by a DCS pin. */
export const DCS_SOURCE_LOCK_REASON =
  "Source is synced from Door43 — detach in Project Settings to edit"

export interface EditorCapabilityOpts {
  /**
   * True while the project's settings carry a `dcsUpstream` cursor (Door43-
   * linked adapter project). While linked, the DCS repair path treats ANY
   * local source divergence as damage and overwrites it, so hand-editing
   * source is forbidden regardless of role — the only sanctioned way out is
   * an explicit detach in Project Settings. Callers should also pass `true`
   * while the linked-state is still UNKNOWN (settings not yet fetched):
   * default-locked can never let a doomed edit slip through, and it only
   * delays the affordance for cloud project_lead+ users by one settings GET.
   */
  hasDcsUpstream?: boolean
}

export function resolveEditorCapabilities(
  project: ProjectRecord | null | undefined,
  opts?: EditorCapabilityOpts,
): EditorCapabilities {
  const level = project?.syncRole?.level ?? null
  const hasDcsUpstream = opts?.hasDcsUpstream === true
  // Source editing: cloud project_lead+ (500), never on a live-linked
  // downstream, never while pinned to a DCS upstream (see EditorCapabilityOpts).
  const canEditSource =
    level !== null &&
    level >= ROLE.PROJECT_LEAD &&
    project?.sourceLinkMode !== "live" &&
    !hasDcsUpstream
  const sourceReadOnlyReason = hasDcsUpstream ? DCS_SOURCE_LOCK_REASON : null

  // Local project (no syncRole): full edit, no badge.
  // Also covers git-imported projects that carry a ProjectPermissions object.
  if (level === null) {
    const perms = project?.permissions
    if (perms) {
      return {
        canEdit: perms.canEditContent,
        canValidate: perms.canEditContent,  // legacy: validation was gated on edit
        canEditSource,  // false for local/git projects (level === null)
        sourceReadOnlyReason,
        readOnlyLabel: perms.canEditContent ? null : "Read-only (imported from git)",
      }
    }
    return { canEdit: true, canValidate: true, canEditSource, sourceReadOnlyReason, readOnlyLabel: null }
  }

  // Cloud project with a live syncRole level.
  if (level >= ROLE.CONTRIBUTOR) {
    return { canEdit: true, canValidate: true, canEditSource, sourceReadOnlyReason, readOnlyLabel: null }
  }
  if (level >= ROLE.REVIEWER) {
    return {
      canEdit: false,
      canValidate: true,
      canEditSource,
      sourceReadOnlyReason,
      readOnlyLabel: "Viewing as reviewer — you can validate and comment",
    }
  }
  if (level >= ROLE.COMMENTER) {
    return {
      canEdit: false,
      canValidate: false,
      canEditSource,
      sourceReadOnlyReason,
      readOnlyLabel: "Viewing as commenter — you can comment",
    }
  }
  // VIEWER or unknown low level
  return {
    canEdit: false,
    canValidate: false,
    canEditSource,
    sourceReadOnlyReason,
    readOnlyLabel: "Viewing as viewer — read only",
  }
}

export function resolvePermissions(project: ProjectRecord | null | undefined): ProjectPermissions {
  return project?.permissions ?? defaultLocalPermissions;
}

export function useProjectPermissions(project: ProjectRecord | null | undefined): ProjectPermissions {
  return useMemo(() => resolvePermissions(project), [project]);
}

export function useEditorCapabilities(
  project: ProjectRecord | null | undefined,
  opts?: EditorCapabilityOpts,
): EditorCapabilities {
  const hasDcsUpstream = opts?.hasDcsUpstream
  return useMemo(
    () => resolveEditorCapabilities(project, { hasDcsUpstream }),
    [project, hasDcsUpstream],
  );
}
