// External domain commands (AQU-533 §3). Callers submit stable domain commands,
// never raw outbox events — the changeset engine compiles them into canonical
// `target.cell.commit` events routed through the /events perimeter.
//
// v1 ships one command (`SetTranslation`), but the shape is a discriminated
// union on `kind` so later commands (`PlanImport`, `LinkMedia`) drop in without
// reshaping the batch envelope. Hand validation (no zod) keeps the worker
// dependency-free.

import { REQUIRED_ROLE, ROLE } from '../events/role-policy'

/** Set (or update) a single cell's translation. Compiles to target.cell.commit. */
export interface SetTranslationCommand {
  kind: 'SetTranslation'
  fileId: string
  cellId: string
  value: string
  valueHtml?: string
}

/** One already-parsed source cell in a PlanImport. Parsing (USFM/JSON/…) is
 *  client/agent-side for v1, exactly like the SPA /import path — the server
 *  receives cells, never a raw recipe (server-side recipe parsing is a Wave-3
 *  TRACE). Field names mirror import-route.ts's source.cell.create inputs:
 *  `id` is the cell identifier (chain key), `content` the source text. */
export interface PlanImportCell {
  /** Cell identifier; a fresh UUIDv7 is minted when omitted. */
  id?: string
  content: string
  canonicalRef?: string
  /** Logical section label (chapter/act/…); stored in the cell metadata bucket. */
  section?: string
  type?: string
}

/** Create a file and its source cells via the changeset pipeline (AQU-533 §5).
 *  Compiles to one file.create + N genesis source.cell.create events, chained by
 *  anchorCellId (mirrors the SPA import + bulk /import semantics). */
export interface PlanImportCommand {
  kind: 'PlanImport'
  fileName: string
  fileType: string
  sourceLanguage?: string
  targetLanguage?: string
  /** Optional uploaded artifact to preserve + link to the created file. */
  artifactId?: string
  cells: PlanImportCell[]
}

/** Create a project (spec §2, receipt-only — D8). Applies a plain row write via
 *  db/shared/projects.ts, NOT events. `projectId` is optional: when omitted the
 *  changeset's URL project id is the definitive id; either way the definitive id
 *  is pinned in the plan at prepare (prepare-time-ids doctrine — a crash-retry
 *  re-applies the SAME id). `orgId` names the target org (null/omitted = a
 *  personal, org-less project). Scope: unscoped or org-scoped credentials only —
 *  a project-scoped credential can never CreateProject, so (act tokens being
 *  required project-scoped at mint) CreateProject is ask-mode-only by design. */
export interface CreateProjectCommand {
  kind: 'CreateProject'
  /** Client-chosen project id; when omitted the changeset URL project id is used. */
  projectId?: string
  name: string
  /** Target org id (numeric, or its string form). Omit for a personal project. */
  orgId?: string | number
}

/** Update a project's settings blob with optimistic-concurrency control (spec
 *  §2, receipt-only — D8). Applies via db/shared/projects.ts's version-guarded
 *  write; when the validation threshold changes the shared module runs the
 *  re-projection locally (sync-worker owns the projection). `ifMatchVersion`
 *  must equal the live settings version at prepare (else plan_stale) and is
 *  re-checked at commit. */
export interface UpdateProjectSettingsCommand {
  kind: 'UpdateProjectSettings'
  projectId: string
  settings: Record<string, unknown>
  ifMatchVersion: number
}

export type Command =
  | SetTranslationCommand
  | PlanImportCommand
  | CreateProjectCommand
  | UpdateProjectSettingsCommand

/** Hard cap on source cells per PlanImport changeset. Above this the plan is
 *  rejected with validation_failed — the manifest-in-R2 pattern for larger
 *  imports is a Wave-3 TRACE (see docs/swarm/AGENT-API-TRACES.md). */
export const PLAN_IMPORT_MAX_CELLS = 5000

export interface CommandValidationIssue {
  index: number
  message: string
}

export type ValidateCommandsResult =
  | { ok: true; commands: Command[] }
  | { ok: false; issues: CommandValidationIssue[] }

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** A plain (non-array, non-null) object — the shape a settings blob must take. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a raw request `commands` value into a typed batch. */
export function validateCommands(raw: unknown): ValidateCommandsResult {
  if (!Array.isArray(raw)) {
    return { ok: false, issues: [{ index: -1, message: 'commands must be an array' }] }
  }
  if (raw.length === 0) {
    return { ok: false, issues: [{ index: -1, message: 'commands must be non-empty' }] }
  }

  const issues: CommandValidationIssue[] = []
  const commands: Command[] = []

  raw.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      issues.push({ index, message: 'command must be an object' })
      return
    }
    const c = item as Record<string, unknown>
    if (c.kind === 'SetTranslation') {
      if (!isNonEmptyString(c.fileId)) {
        issues.push({ index, message: 'SetTranslation.fileId must be a non-empty string' })
        return
      }
      if (!isNonEmptyString(c.cellId)) {
        issues.push({ index, message: 'SetTranslation.cellId must be a non-empty string' })
        return
      }
      if (typeof c.value !== 'string') {
        issues.push({ index, message: 'SetTranslation.value must be a string' })
        return
      }
      if (c.valueHtml !== undefined && typeof c.valueHtml !== 'string') {
        issues.push({ index, message: 'SetTranslation.valueHtml must be a string when present' })
        return
      }
      commands.push({
        kind: 'SetTranslation',
        fileId: c.fileId,
        cellId: c.cellId,
        value: c.value,
        ...(c.valueHtml !== undefined ? { valueHtml: c.valueHtml } : {}),
      })
      return
    }
    if (c.kind === 'PlanImport') {
      if (!isNonEmptyString(c.fileName)) {
        issues.push({ index, message: 'PlanImport.fileName must be a non-empty string' })
        return
      }
      if (!isNonEmptyString(c.fileType)) {
        issues.push({ index, message: 'PlanImport.fileType must be a non-empty string' })
        return
      }
      if (c.sourceLanguage !== undefined && typeof c.sourceLanguage !== 'string') {
        issues.push({ index, message: 'PlanImport.sourceLanguage must be a string when present' })
        return
      }
      if (c.targetLanguage !== undefined && typeof c.targetLanguage !== 'string') {
        issues.push({ index, message: 'PlanImport.targetLanguage must be a string when present' })
        return
      }
      if (c.artifactId !== undefined && !isNonEmptyString(c.artifactId)) {
        issues.push({ index, message: 'PlanImport.artifactId must be a non-empty string when present' })
        return
      }
      if (!Array.isArray(c.cells)) {
        issues.push({ index, message: 'PlanImport.cells must be an array' })
        return
      }
      const cells: PlanImportCell[] = []
      let cellInvalid = false
      c.cells.forEach((rawCell, cellIndex) => {
        if (typeof rawCell !== 'object' || rawCell === null) {
          issues.push({ index, message: `PlanImport.cells[${cellIndex}] must be an object` })
          cellInvalid = true
          return
        }
        const rc = rawCell as Record<string, unknown>
        if (typeof rc.content !== 'string') {
          issues.push({ index, message: `PlanImport.cells[${cellIndex}].content must be a string` })
          cellInvalid = true
          return
        }
        if (rc.id !== undefined && !isNonEmptyString(rc.id)) {
          issues.push({ index, message: `PlanImport.cells[${cellIndex}].id must be a non-empty string when present` })
          cellInvalid = true
          return
        }
        for (const k of ['canonicalRef', 'section', 'type'] as const) {
          if (rc[k] !== undefined && typeof rc[k] !== 'string') {
            issues.push({ index, message: `PlanImport.cells[${cellIndex}].${k} must be a string when present` })
            cellInvalid = true
            return
          }
        }
        cells.push({
          ...(rc.id !== undefined ? { id: rc.id as string } : {}),
          content: rc.content,
          ...(rc.canonicalRef !== undefined ? { canonicalRef: rc.canonicalRef as string } : {}),
          ...(rc.section !== undefined ? { section: rc.section as string } : {}),
          ...(rc.type !== undefined ? { type: rc.type as string } : {}),
        })
      })
      if (cellInvalid) return
      commands.push({
        kind: 'PlanImport',
        fileName: c.fileName,
        fileType: c.fileType,
        ...(c.sourceLanguage !== undefined ? { sourceLanguage: c.sourceLanguage as string } : {}),
        ...(c.targetLanguage !== undefined ? { targetLanguage: c.targetLanguage as string } : {}),
        ...(c.artifactId !== undefined ? { artifactId: c.artifactId as string } : {}),
        cells,
      })
      return
    }
    if (c.kind === 'CreateProject') {
      if (!isNonEmptyString(c.name)) {
        issues.push({ index, message: 'CreateProject.name must be a non-empty string' })
        return
      }
      if (c.projectId !== undefined && !isNonEmptyString(c.projectId)) {
        issues.push({ index, message: 'CreateProject.projectId must be a non-empty string when present' })
        return
      }
      if (
        c.orgId !== undefined &&
        !isNonEmptyString(c.orgId) &&
        typeof c.orgId !== 'number'
      ) {
        issues.push({ index, message: 'CreateProject.orgId must be a string or number when present' })
        return
      }
      commands.push({
        kind: 'CreateProject',
        ...(c.projectId !== undefined ? { projectId: c.projectId as string } : {}),
        name: c.name,
        ...(c.orgId !== undefined ? { orgId: c.orgId as string | number } : {}),
      })
      return
    }
    if (c.kind === 'UpdateProjectSettings') {
      if (!isNonEmptyString(c.projectId)) {
        issues.push({ index, message: 'UpdateProjectSettings.projectId must be a non-empty string' })
        return
      }
      if (!isPlainObject(c.settings)) {
        issues.push({ index, message: 'UpdateProjectSettings.settings must be a plain object' })
        return
      }
      if (
        typeof c.ifMatchVersion !== 'number' ||
        !Number.isInteger(c.ifMatchVersion) ||
        c.ifMatchVersion < 0
      ) {
        issues.push({ index, message: 'UpdateProjectSettings.ifMatchVersion must be an integer >= 0' })
        return
      }
      commands.push({
        kind: 'UpdateProjectSettings',
        projectId: c.projectId,
        settings: c.settings,
        ifMatchVersion: c.ifMatchVersion,
      })
      return
    }
    issues.push({ index, message: `unsupported command kind: ${String(c.kind)}` })
  })

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, commands }
}

/** Stable key for de-duping / joining commands ↔ preconditions by target cell. */
/**
 * Minimum project role a caller must hold to stage/commit a command — the SAME
 * floor the command's compiled event(s) hit at the /events perimeter, sourced
 * from role-policy.ts (the single source of truth). SetTranslation compiles to
 * target.cell.commit (CONTRIBUTOR); PlanImport compiles to file.create +
 * source.cell.create (PROJECT_LEAD). Staging a plan you could never commit
 * leaks the server-computed effect summary, so prepare enforces this too.
 */
export function requiredRoleForCommand(c: Command): number {
  if (c.kind === 'PlanImport') {
    return Math.max(REQUIRED_ROLE['file.create'], REQUIRED_ROLE['source.cell.create'])
  }
  // Receipt-only project-lifecycle commands take their OWN prepare/commit path
  // (their role gate is org-level for CreateProject, project-MAINTAINER for
  // UpdateProjectSettings), so this generic per-command floor is never consulted
  // for them — but the union must be covered. MAINTAINER is the honest floor.
  if (c.kind === 'CreateProject' || c.kind === 'UpdateProjectSettings') {
    return ROLE.MAINTAINER
  }
  return REQUIRED_ROLE['target.cell.commit']
}

export function cellKey(fileId: string, cellId: string): string {
  return `${fileId} ${cellId}`
}
