// External domain commands (AQU-533 §3). Callers submit stable domain commands,
// never raw outbox events — the changeset engine compiles them into canonical
// `target.cell.commit` events routed through the /events perimeter.
//
// v1 ships one command (`SetTranslation`), but the shape is a discriminated
// union on `kind` so later commands (`PlanImport`, `LinkMedia`) drop in without
// reshaping the batch envelope. Hand validation (no zod) keeps the worker
// dependency-free.

import { REQUIRED_ROLE } from '../events/role-policy'

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

/** Attach an uploaded audio artifact to a cell (Agent API v1.1 §3). Compiles to
 *  cell.audio.attach + cell.audio.select events. The artifact must be an
 *  `audio`-kind artifact in the same project (uploaded via the REST artifact
 *  endpoint with `x-artifact-kind: audio`). */
export interface LinkMediaCommand {
  kind: 'LinkMedia'
  fileId: string
  cellId: string
  artifactId: string
}

export type Command = SetTranslationCommand | PlanImportCommand | LinkMediaCommand

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
    if (c.kind === 'LinkMedia') {
      if (!isNonEmptyString(c.fileId)) {
        issues.push({ index, message: 'LinkMedia.fileId must be a non-empty string' })
        return
      }
      if (!isNonEmptyString(c.cellId)) {
        issues.push({ index, message: 'LinkMedia.cellId must be a non-empty string' })
        return
      }
      if (!isNonEmptyString(c.artifactId)) {
        issues.push({ index, message: 'LinkMedia.artifactId must be a non-empty string' })
        return
      }
      commands.push({
        kind: 'LinkMedia',
        fileId: c.fileId,
        cellId: c.cellId,
        artifactId: c.artifactId,
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
  if (c.kind === 'LinkMedia') {
    // Compiles to cell.audio.attach + cell.audio.select (both CONTRIBUTOR).
    return Math.max(REQUIRED_ROLE['cell.audio.attach'], REQUIRED_ROLE['cell.audio.select'])
  }
  return REQUIRED_ROLE['target.cell.commit']
}

export function cellKey(fileId: string, cellId: string): string {
  return `${fileId} ${cellId}`
}
