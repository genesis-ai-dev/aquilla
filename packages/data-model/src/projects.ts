// Project + member + org types — auth-worker `/api/v2/*` shapes.
//
// AD-9 source-project linking: a project may reference at most one upstream
// via `sourceProjectId` (self-FK). Three project shapes:
//   - Self-contained (default): sourceProjectId=null, targetLanguage set
//   - Source-only:              sourceProjectId=null, targetLanguage unset
//   - Linked target:            sourceProjectId set,  targetLanguage set

/** Hierarchical role ladder (spec 01-personas-and-roles.md). */
export type RoleLevel = 100 | 200 | 300 | 400 | 500 | 600 | 700

export type RoleName =
  | "viewer"        // 100 — read cells + comments
  | "commenter"     // 200 — viewer + write comments
  | "reviewer"      // 300 — commenter + validate cells
  | "contributor"   // 400 — reviewer + edit cell values
  | "project_lead"  // 500 — contributor + assign reviewers + link/detach source
  | "maintainer"    // 600 — project_lead + manage members + settings
  | "owner"         // 700 — maintainer + delete + transfer

export interface Project {
  id: string
  name: string
  /** Owning org. Null for personal projects. */
  orgId: number | null
  /** Creator user id. */
  createdBy: number
  createdAt: string
  updatedAt: string
  /** AD-9: upstream source project. Null for self-contained / source-only. */
  sourceProjectId: string | null
  /** Set when the project has been archived; otherwise null. */
  archivedAt: string | null
  archivedBy: number | null
}

export interface ProjectMember {
  projectId: string
  userId: number
  username: string
  roleLevel: RoleLevel
  grantedBy: number | null
  grantedAt: string
}

export interface ProjectInvite {
  /** The shareable token. */
  token: string
  /** Projects this token grants access to. Multi-project invites share one token. */
  projectIds: string[]
  roleLevel: RoleLevel
  createdBy: number
  createdAt: string
  expiresAt: string | null
  usedBy: number | null
  usedAt: string | null
}

/**
 * Versioned per-project settings — JSON blob with monotonic `version` for
 * optimistic concurrency. PUT requires `ifMatchVersion` from the caller;
 * mismatch returns 409.
 *
 * `targetLanguage === null` identifies an AD-9 source-only project.
 */
export interface ProjectSettings {
  projectId: string
  settings: {
    sourceLanguage?: string
    targetLanguage?: string | null
    systemPrompt?: string
    rules?: TranslationRule[]
    rulePenalties?: Record<string, number>
    decaySettings?: {
      endorsementTarget?: number
      decayWarnThreshold?: number
    }
    /** @deprecated Use decaySettings. Kept as a read/write alias during migration. */
    healthSettings?: Record<string, unknown>
    validationCount?: number
    validationCountAudio?: number
  }
  version: number
  updatedAt: string
  updatedBy: number | null
}

/** Translation rule used by the rules engine. */
export interface TranslationRule {
  id: string
  name: string
  description?: string
  severity: "info" | "warn" | "error"
  enabled: boolean
  params?: Record<string, unknown>
}

/** Org-level membership grant (applies across every project in the org). */
export interface OrgMember {
  orgId: number
  userId: number
  username: string
  roleLevel: RoleLevel
  grantedBy: number | null
  grantedAt: string
  /** Last time this member produced a write. Server-tracked. */
  lastActiveAt: string | null
}

export interface Org {
  id: number
  name: string | null
  ownerUserId: number
  createdAt: string
  updatedAt: string
}

/** A downstream project linked to this one as its source (AD-9). */
export interface DownstreamProject {
  id: string
  name: string
  targetLanguage: string | null
}

/** Result of POST /api/v2/projects/:id/detach-source — snapshot burst stats. */
export interface DetachResult {
  /** Snapshot count of source cells copied from upstream into this project. */
  snapshotCellCount: number
  /** The upstream id that was detached. */
  previousSourceProjectId: string
}
