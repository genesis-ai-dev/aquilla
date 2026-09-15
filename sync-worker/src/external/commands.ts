// External domain commands (AQU-533 §3). Callers submit stable domain commands,
// never raw outbox events — the changeset engine compiles them into canonical
// `target.cell.commit` events routed through the /events perimeter.
//
// v1 ships one command (`SetTranslation`), but the shape is a discriminated
// union on `kind` so later commands (`PlanImport`, `LinkMedia`) drop in without
// reshaping the batch envelope. Hand validation (no zod) keeps the worker
// dependency-free.

import { REQUIRED_ROLE, ROLE } from '../events/role-policy'
import type { AiDraftProvenance } from '../events/types'
import {
  validatePlanImportManifest,
  type PlanImportCell,
  type PlanImportManifest,
  type PlanImportVariant,
} from './import-manifest'
import {
  staticPatchSettingsFloor,
  validatePatchSettingsCommand,
  type PatchSettingsCommand,
} from './commands-patch-settings'
import {
  emitEventsFloor,
  validateEmitEventsCommand,
  type EmitEventsCommand,
} from './commands-emit-events'
import {
  draftCellsFloor,
  validateDraftCellsCommand,
  type DraftCellsCommand,
} from './commands-draft-cells'
import {
  cellFieldsFloor,
  isCellFieldCommand,
  isCellFieldKind,
  validateCellFieldCommand,
  type CellFieldCommand,
  type SetSourceCommand,
  type SetTimingCommand,
  type SetTrackOverrideCommand,
  type SetTranscriptionCommand,
} from './commands-cell-fields'
import {
  MEMBERSHIP_FLOOR,
  isMembershipCommand,
  validateMembershipCommand,
  type MembershipCommand,
} from './commands-membership'
import {
  renameFileFloor,
  validateRenameFileCommand,
  type RenameFileCommand,
} from './commands-rename-file'
import {
  projectLifecycleFloor,
  validateProjectLifecycleCommand,
  type ProjectLifecycleCommand,
} from './commands-project-lifecycle'
import {
  SET_BRIEF_REQUIRED_ROLE,
  validateSetBriefCommand,
  type SetBriefCommand,
} from './commands-set-brief'
import {
  isOrgMemberCommand,
  validateOrgMemberCommand,
  type OrgMemberCommand,
} from './commands-org-members'
import {
  MEMORY_COMMAND_KINDS,
  isMemoryCommand,
  memoryCommandFloor,
  validateMemoryCommand,
  type MemoryCommand,
} from './commands-memory'
import {
  isStructureCommandKind,
  structureCommandFloor,
  validateStructureCommand,
  type StructureCommand,
} from './commands-structure'

/** True for the four AQU-1228 Living Memory command kinds. Narrows a raw
 *  `kind` string BEFORE validation, unlike `isMemoryCommand` which narrows an
 *  already-typed command. */
function isMemoryCommandKind(kind: string): boolean {
  return (MEMORY_COMMAND_KINDS as readonly string[]).includes(kind)
}

export type { PlanImportCell, PlanImportManifest, PlanImportVariant } from './import-manifest'
export type { PatchSettingsCommand, PatchSettingsOp } from './commands-patch-settings'
export type { EmitEventsCommand, EmitEventInput } from './commands-emit-events'
export type { DraftCellsCommand } from './commands-draft-cells'
export type {
  CellFieldCommand,
  SetSourceCommand,
  SetTimingCommand,
  SetTrackOverrideCommand,
  SetTranscriptionCommand,
  TrackPatch,
} from './commands-cell-fields'
export type {
  InviteMemberCommand,
  MembershipCommand,
  RemoveMemberCommand,
  SetRoleCommand,
} from './commands-membership'
export { isMembershipCommand } from './commands-membership'
export type { RenameFileCommand } from './commands-rename-file'
export type {
  ArchiveProjectCommand,
  ProjectLifecycleCommand,
  RenameProjectCommand,
  UnarchiveProjectCommand,
} from './commands-project-lifecycle'
export type { SetBriefCommand } from './commands-set-brief'
export type {
  AddOrgMemberCommand,
  OrgMemberCommand,
  RemoveOrgMemberCommand,
  SetOrgRoleCommand,
} from './commands-org-members'
export type {
  AddExampleCommand,
  AddDecisionCommand,
  RetireExampleCommand,
  AddNoteCommand,
  MemoryCommand,
} from './commands-memory'
export type {
  DeleteCellCommand,
  InsertCellCommand,
  SplitCellCommand,
  SplitTargetHandling,
  SplitTargetOffset,
  StructureCommand,
} from './commands-structure'
export { isStructureCommandKind } from './commands-structure'
export { cellKey, laneCellKey } from './cell-keys'
export { isCellFieldCommand } from './commands-cell-fields'

/** Set (or update) a single cell's translation. Compiles to target.cell.commit. */
export interface SetTranslationCommand {
  kind: 'SetTranslation'
  fileId: string
  cellId: string
  value: string
  valueHtml?: string
  /** Target-language lane (AQU-538): a language tag registered in the
   *  project's settings.targetLanes (e.g. "es", "pt"). Omit for the default
   *  lane. Prepare rejects an unregistered lane — register it with
   *  UpdateProjectSettings first. */
  laneId?: string
  /** SERVER-MINTED (AQU-1186). Set only by the DraftCells prepare path when it
   *  materializes the copilot's output into SetTranslation commands; it makes
   *  the compiled commit carry `ai_suggestion` + `ai_draft`, so the cell lands
   *  as `ai_drafted` and a human reviews it as AI work. `validateCommands`
   *  rebuilds every command from known keys only, so a caller CANNOT set this
   *  on a hand-written SetTranslation — provenance is never self-asserted. */
  aiDraft?: AiDraftProvenance
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
  /** Optional normalized profile/recipe selected by the unified importer. */
  manifest?: PlanImportManifest
  cells: PlanImportCell[]
}

/** Create a project (spec §2, receipt-only — D8). Applies a plain row write via
 *  db/shared/projects.ts, NOT events. `projectId` is optional: when omitted the
 *  changeset's URL project id is the definitive id; either way the definitive id
 *  is pinned in the plan at prepare (prepare-time-ids doctrine — a crash-retry
 *  re-applies the SAME id). `orgId` names the target org (null/omitted = a
 *  personal, org-less project). Scope: unscoped or org-scoped credentials only —
 *  a project-scoped credential can never CreateProject, so (act tokens being
 *  required project-scoped at mint) CreateProject is ask-mode-only by design.
 *
 *  AQU-1223: the accepted field set is CLOSED — anything not listed here is
 *  rejected by name at validation (see CREATE_PROJECT_FIELDS). It used to be
 *  silently dropped, which is the worse failure: a caller that sends
 *  `description` or a typo'd `targetLangauge` got a 200 and a blank project,
 *  with nothing anywhere signalling that its configuration never landed. */
export interface CreateProjectCommand {
  kind: 'CreateProject'
  /** Client-chosen project id; when omitted the changeset URL project id is used. */
  projectId?: string
  name: string
  /** Target org id (numeric, or its string form). Omit for a personal project. */
  orgId?: string | number
  /** Seed `settings.sourceLanguage` at creation — the same key the UI's create
   *  flow patches immediately after createCloudProject. Omit to leave unset. */
  sourceLanguage?: string
  /** Seed `settings.targetLanguage` at creation. Omit (or '') for a
   *  source-only project, mirroring the UI's source-only shape. */
  targetLanguage?: string
}

/** The complete accepted key set for a CreateProject command body (AQU-1223).
 *  Every other key is a `validation_failed` naming that key — never a silent
 *  drop. Settings beyond the language pair go through PatchSettings, which owns
 *  the version guard and the per-key role floors that a create cannot honor. */
export const CREATE_PROJECT_FIELDS: readonly string[] = [
  'kind',
  'projectId',
  'name',
  'orgId',
  'sourceLanguage',
  'targetLanguage',
]

/** Create an organization (AQU-1221, receipt-only like CreateProject). Applies
 *  a plain row write via db/shared/orgs.ts, NOT events. The credential's
 *  minting user becomes the org's OWNER — an agent never becomes a member
 *  itself, and there is no parameter that could name a different owner. Scope:
 *  UNSCOPED credentials only — an org-scoped credential is confined to its own
 *  org and a project-scoped one to its own project, so neither may mint a new
 *  tenant. Like CreateProject it is forced to ask-mode at prepare, so every
 *  agent-initiated org creation passes a human approval.
 *
 *  `name` is the only parameter, by design: tier / billing / entitlement fields
 *  are not settable through this surface (a new org has no org_billing row,
 *  i.e. the default plan=none), and supplying one is validation_failed. */
export interface CreateOrgCommand {
  kind: 'CreateOrg'
  name: string
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

export type Command =
  | MemoryCommand
  | SetTranslationCommand
  | PlanImportCommand
  | CreateProjectCommand
  | CreateOrgCommand
  | UpdateProjectSettingsCommand
  | LinkMediaCommand
  | PatchSettingsCommand
  | EmitEventsCommand
  | DraftCellsCommand
  | CellFieldCommand
  | MembershipCommand
  | RenameFileCommand
  | ProjectLifecycleCommand
  | SetBriefCommand
  | OrgMemberCommand
  | StructureCommand

/** Hard cap on source cells per PlanImport changeset. Above this the plan is
 *  rejected with validation_failed — the manifest-in-R2 pattern for larger
 *  imports is a Wave-3 TRACE (see docs/swarm/AGENT-API-TRACES.md). */
export const PLAN_IMPORT_MAX_CELLS = 5000

/** Longest org name CreateOrg will stage (AQU-1221). The column is TEXT; this
 *  is a sanity bound so an agent cannot park a document in the org switcher. */
export const CREATE_ORG_MAX_NAME_LENGTH = 120

/** Fields a CreateOrg command may carry. Anything else is validation_failed
 *  naming the field — the guardrail that keeps tier / billing / entitlement
 *  values (`plan`, `tier`, `addonPacks`, …) off the agent surface entirely,
 *  rather than silently ignoring them. */
const CREATE_ORG_ALLOWED_FIELDS = new Set(['kind', 'name'])

/** Billing/entitlement field names an agent might plausibly try, called out by
 *  name so the rejection explains WHY rather than just "unsupported field".
 *  Every one of these is owned by the Stripe/billing surface (org_billing),
 *  never by org creation. */
const CREATE_ORG_BILLING_FIELDS = new Set([
  'tier',
  'plan',
  'billing',
  'entitlements',
  'entitlement',
  'status',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'addonPacks',
  'complimentaryWords',
  'hardCapWords',
])

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

/** Content-free names an agent reaches for when it has nothing better (AQU-1140).
 *  A project is a durable, human-facing object — "default" tells the humans who
 *  later open the workspace nothing about what is in it. Kept deliberately small:
 *  only names that carry no information at all. Names that merely LOOK generic
 *  but a human might genuinely have chosen ("Test project", "Sandbox") are not
 *  listed — a false rejection is worse than a lazy name a human picked. */
const PLACEHOLDER_PROJECT_NAMES: ReadonlySet<string> = new Set([
  'default',
  'default project',
  'new project',
  'no name',
  'none',
  'placeholder',
  'project',
  'tbd',
  'unnamed',
  'unnamed project',
  'untitled',
  'untitled project',
])

/** Normalize a candidate project name for placeholder comparison: case-fold,
 *  turn separators/punctuation into spaces (so `new_project` / `Default-Project`
 *  collapse onto the same key), squash runs of whitespace, and drop a trailing
 *  auto-increment suffix (`untitled 2` → `untitled`). */
function normalizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+\d+$/, '')
    .trim()
}

/** True when `name` is a content-free placeholder rather than a real project
 *  name. Exported for the SPA/worker tests and any future caller that wants to
 *  apply the same bar before offering a name to a human. */
export function isPlaceholderProjectName(name: string): boolean {
  return PLACEHOLDER_PROJECT_NAMES.has(normalizeProjectName(name))
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
      if (c.laneId !== undefined && (!isNonEmptyString(c.laneId) || c.laneId.length > 64)) {
        issues.push({
          index,
          message: 'SetTranslation.laneId must be a non-empty string (max 64 chars) when present — omit it for the default lane',
        })
        return
      }
      commands.push({
        kind: 'SetTranslation',
        fileId: c.fileId,
        cellId: c.cellId,
        value: c.value,
        ...(c.valueHtml !== undefined ? { valueHtml: c.valueHtml } : {}),
        ...(c.laneId !== undefined ? { laneId: c.laneId } : {}),
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
      let manifest: PlanImportManifest | undefined
      if (c.manifest !== undefined) {
        if (!isPlainObject(c.manifest)) {
          issues.push({ index, message: 'PlanImport.manifest must be an object when present' })
          return
        }
        const m = c.manifest
        if (
          m.version !== 1 ||
          !isNonEmptyString(m.profileId) ||
          !isNonEmptyString(m.profileVersion) ||
          typeof m.deterministic !== 'boolean' ||
          !isNonEmptyString(m.fidelity)
        ) {
          issues.push({ index, message: 'PlanImport.manifest has invalid required fields' })
          return
        }
        if (m.memberPath !== undefined && typeof m.memberPath !== 'string') {
          issues.push({ index, message: 'PlanImport.manifest.memberPath must be a string when present' })
          return
        }
        if (m.warningCounts !== undefined && !isPlainObject(m.warningCounts)) {
          issues.push({ index, message: 'PlanImport.manifest.warningCounts must be an object when present' })
          return
        }
        if (
          m.warningCounts !== undefined &&
          Object.values(m.warningCounts).some((count) => typeof count !== 'number' || !Number.isInteger(count) || count < 0)
        ) {
          issues.push({ index, message: 'PlanImport.manifest.warningCounts values must be non-negative integers' })
          return
        }
        if (m.recipe !== undefined) {
          if (!isPlainObject(m.recipe) || !isPlainObject(m.recipe.config)) {
            issues.push({ index, message: 'PlanImport.manifest.recipe and recipe.config must be objects' })
            return
          }
          if (
            m.recipe.version !== 1 ||
            !isNonEmptyString(m.recipe.name) ||
            !isNonEmptyString(m.recipe.inputFormat) ||
            !isNonEmptyString(m.recipe.strategy) ||
            (m.recipe.roundTripVerified !== undefined && typeof m.recipe.roundTripVerified !== 'boolean')
          ) {
            issues.push({ index, message: 'PlanImport.manifest.recipe has invalid fields' })
            return
          }
        }
        manifest = m as unknown as PlanImportManifest
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
        for (const k of ['canonicalRef', 'section', 'type', 'contentHtml', 'unitKey', 'speaker'] as const) {
          if (rc[k] !== undefined && typeof rc[k] !== 'string') {
            issues.push({ index, message: `PlanImport.cells[${cellIndex}].${k} must be a string when present` })
            cellInvalid = true
            return
          }
        }
        if (rc.displayLabel !== undefined && rc.displayLabel !== null && typeof rc.displayLabel !== 'string') {
          issues.push({ index, message: `PlanImport.cells[${cellIndex}].displayLabel must be a string or null when present` })
          cellInvalid = true
          return
        }
        for (const k of ['address', 'sourceLocator', 'metadata'] as const) {
          if (rc[k] !== undefined && !isPlainObject(rc[k])) {
            issues.push({ index, message: `PlanImport.cells[${cellIndex}].${k} must be an object when present` })
            cellInvalid = true
            return
          }
        }
        for (const k of ['physicalOrder', 'startMs', 'endMs'] as const) {
          if (rc[k] !== undefined && (typeof rc[k] !== 'number' || !Number.isFinite(rc[k]))) {
            issues.push({ index, message: `PlanImport.cells[${cellIndex}].${k} must be a finite number when present` })
            cellInvalid = true
            return
          }
        }
        if (rc.paragraphStart !== undefined && typeof rc.paragraphStart !== 'boolean') {
          issues.push({ index, message: `PlanImport.cells[${cellIndex}].paragraphStart must be a boolean when present` })
          cellInvalid = true
          return
        }
        let variants: PlanImportVariant[] | undefined
        if (rc.variants !== undefined) {
          if (!Array.isArray(rc.variants)) {
            issues.push({ index, message: `PlanImport.cells[${cellIndex}].variants must be an array when present` })
            cellInvalid = true
            return
          }
          variants = []
          for (const [variantIndex, rawVariant] of rc.variants.entries()) {
            if (!isPlainObject(rawVariant) || typeof rawVariant.laneId !== 'string' || typeof rawVariant.content !== 'string') {
              issues.push({ index, message: `PlanImport.cells[${cellIndex}].variants[${variantIndex}] has invalid required fields` })
              cellInvalid = true
              return
            }
            if (rawVariant.languageTag !== undefined && typeof rawVariant.languageTag !== 'string') {
              issues.push({ index, message: `PlanImport.cells[${cellIndex}].variants[${variantIndex}].languageTag must be a string when present` })
              cellInvalid = true
              return
            }
            if (rawVariant.contentHtml !== undefined && typeof rawVariant.contentHtml !== 'string') {
              issues.push({ index, message: `PlanImport.cells[${cellIndex}].variants[${variantIndex}].contentHtml must be a string when present` })
              cellInvalid = true
              return
            }
            variants.push({
              laneId: rawVariant.laneId,
              content: rawVariant.content,
              ...(rawVariant.languageTag !== undefined ? { languageTag: rawVariant.languageTag } : {}),
              ...(rawVariant.contentHtml !== undefined ? { contentHtml: rawVariant.contentHtml } : {}),
            })
          }
        }
        cells.push({
          ...(rc.id !== undefined ? { id: rc.id as string } : {}),
          content: rc.content,
          ...(rc.contentHtml !== undefined ? { contentHtml: rc.contentHtml as string } : {}),
          ...(rc.canonicalRef !== undefined ? { canonicalRef: rc.canonicalRef as string } : {}),
          ...(rc.section !== undefined ? { section: rc.section as string } : {}),
          ...(rc.type !== undefined ? { type: rc.type as string } : {}),
          ...(rc.unitKey !== undefined ? { unitKey: rc.unitKey as string } : {}),
          ...(rc.displayLabel !== undefined ? { displayLabel: rc.displayLabel as string | null } : {}),
          ...(rc.address !== undefined ? { address: rc.address as Record<string, unknown> } : {}),
          ...(rc.sourceLocator !== undefined ? { sourceLocator: rc.sourceLocator as Record<string, unknown> } : {}),
          ...(rc.physicalOrder !== undefined ? { physicalOrder: rc.physicalOrder as number } : {}),
          ...(rc.startMs !== undefined ? { startMs: rc.startMs as number } : {}),
          ...(rc.endMs !== undefined ? { endMs: rc.endMs as number } : {}),
          ...(rc.speaker !== undefined ? { speaker: rc.speaker as string } : {}),
          ...(rc.paragraphStart !== undefined ? { paragraphStart: rc.paragraphStart as boolean } : {}),
          ...(rc.metadata !== undefined ? { metadata: rc.metadata as Record<string, unknown> } : {}),
          ...(variants !== undefined ? { variants } : {}),
        })
      })
      if (cellInvalid) return
      const manifestIssues = validatePlanImportManifest({ fileType: c.fileType, cells, ...(manifest ? { manifest } : {}) })
      if (manifestIssues.length > 0) {
        for (const message of manifestIssues) issues.push({ index, message: `PlanImport.${message}` })
        return
      }
      commands.push({
        kind: 'PlanImport',
        fileName: c.fileName,
        fileType: c.fileType,
        ...(c.sourceLanguage !== undefined ? { sourceLanguage: c.sourceLanguage as string } : {}),
        ...(c.targetLanguage !== undefined ? { targetLanguage: c.targetLanguage as string } : {}),
        ...(c.artifactId !== undefined ? { artifactId: c.artifactId as string } : {}),
        ...(manifest ? { manifest } : {}),
        cells,
      })
      return
    }
    if (c.kind === 'CreateProject') {
      // Unknown-field rejection FIRST (AQU-1223): report every unrecognized key
      // at once rather than one per round-trip, and before the shape checks so a
      // typo'd field never rides along with an otherwise-valid body.
      const unknown = Object.keys(c).filter((k) => !CREATE_PROJECT_FIELDS.includes(k))
      if (unknown.length > 0) {
        issues.push({
          index,
          message:
            `CreateProject does not accept ${unknown.map((k) => `\`${k}\``).join(', ')} — ` +
            `accepted fields are ${CREATE_PROJECT_FIELDS.filter((k) => k !== 'kind')
              .map((k) => `\`${k}\``)
              .join(', ')}. Project settings beyond the language pair are written with ` +
            `PatchSettings; membership is InviteMember/SetRole.`,
        })
        return
      }
      if (!isNonEmptyString(c.name)) {
        issues.push({ index, message: 'CreateProject.name must be a non-empty string' })
        return
      }
      // AQU-1140: the name is what humans see in the workspace forever after, so
      // an agent may not fall back to a content-free placeholder. Trim first —
      // a whitespace-only name is as empty as '', and " Default " is as much a
      // placeholder as "default".
      const name = c.name.trim()
      if (name.length === 0) {
        issues.push({ index, message: 'CreateProject.name must be a non-empty string' })
        return
      }
      if (isPlaceholderProjectName(name)) {
        issues.push({
          index,
          message:
            `CreateProject.name "${c.name}" is a placeholder, not a project name. ` +
            'Derive a meaningful one from what is being imported (the source folder ' +
            'or file name, the publication/curriculum title, the language pair), or ' +
            'ask the human what to call it.',
        })
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
      // '' is meaningful for targetLanguage (the UI's source-only shape writes
      // exactly that), so these are string-checked, not non-empty-checked.
      if (c.sourceLanguage !== undefined && typeof c.sourceLanguage !== 'string') {
        issues.push({ index, message: 'CreateProject.sourceLanguage must be a string when present' })
        return
      }
      if (c.targetLanguage !== undefined && typeof c.targetLanguage !== 'string') {
        issues.push({ index, message: 'CreateProject.targetLanguage must be a string when present' })
        return
      }
      commands.push({
        kind: 'CreateProject',
        ...(c.projectId !== undefined ? { projectId: c.projectId as string } : {}),
        name,
        ...(c.orgId !== undefined ? { orgId: c.orgId as string | number } : {}),
        ...(c.sourceLanguage !== undefined ? { sourceLanguage: c.sourceLanguage } : {}),
        ...(c.targetLanguage !== undefined ? { targetLanguage: c.targetLanguage } : {}),
      })
      return
    }
    if (c.kind === 'CreateOrg') {
      // Reject a billing/entitlement field BEFORE the shape check so the
      // message names the offending field even when `name` is also missing.
      const billingField = Object.keys(c).find((k) => CREATE_ORG_BILLING_FIELDS.has(k))
      if (billingField !== undefined) {
        issues.push({
          index,
          message: `CreateOrg cannot set billing/entitlement field "${billingField}" — a new org always gets the default tier`,
        })
        return
      }
      const unknownField = Object.keys(c).find((k) => !CREATE_ORG_ALLOWED_FIELDS.has(k))
      if (unknownField !== undefined) {
        issues.push({ index, message: `CreateOrg does not accept field "${unknownField}"` })
        return
      }
      if (!isNonEmptyString(c.name) || c.name.trim().length === 0) {
        issues.push({ index, message: 'CreateOrg.name must be a non-empty string' })
        return
      }
      if (c.name.length > CREATE_ORG_MAX_NAME_LENGTH) {
        issues.push({
          index,
          message: `CreateOrg.name must be at most ${CREATE_ORG_MAX_NAME_LENGTH} characters`,
        })
        return
      }
      commands.push({ kind: 'CreateOrg', name: c.name.trim() })
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
    if (c.kind === 'PatchSettings') {
      const cmd = validatePatchSettingsCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (c.kind === 'EmitEvents') {
      const cmd = validateEmitEventsCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (c.kind === 'DraftCells') {
      const cmd = validateDraftCellsCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    // AQU-1183 cell-field commands (SetSource / SetTranscription / SetTiming /
    // SetTrackOverride) — one validator for the family.
    if (isCellFieldKind(c.kind)) {
      const cmd = validateCellFieldCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (isMembershipCommand(c as { kind: string })) {
      const cmd = validateMembershipCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (c.kind === 'RenameFile') {
      const cmd = validateRenameFileCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (
      c.kind === 'RenameProject' ||
      c.kind === 'ArchiveProject' ||
      c.kind === 'UnarchiveProject'
    ) {
      const cmd = validateProjectLifecycleCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (c.kind === 'SetBrief') {
      const cmd = validateSetBriefCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (isOrgMemberCommand(c as { kind: string })) {
      const cmd = validateOrgMemberCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    // AQU-1228 Living Memory writes — four kinds sharing one validator.
    if (typeof c.kind === 'string' && isMemoryCommandKind(c.kind)) {
      const cmd = validateMemoryCommand(c, index, issues)
      if (cmd) commands.push(cmd)
      return
    }
    if (isStructureCommandKind(c.kind)) {
      const cmd = validateStructureCommand(c, index, issues)
      if (cmd) commands.push(cmd)
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

/**
 * Minimum project role a caller must hold to stage/commit a command — the SAME
 * floor the command's compiled event(s) hit at the /events perimeter, sourced
 * from role-policy.ts (the single source of truth). SetTranslation compiles to
 * target.cell.commit (CONTRIBUTOR); PlanImport compiles to file.create +
 * source.cell.create, and the max keeps it at file.create's PROJECT_LEAD even
 * now that source.cell.create's static floor is COMMENTER. The project's
 * `cellEditingFloor` tier plays no part here: it is a product rule enforced at
 * the app's buttons, never at this perimeter, and this surface was exempt from
 * it even while it was checked server-side (see authorize.ts). Staging a plan
 * you could never commit leaks the server-computed effect summary, so prepare
 * enforces this too.
 */
export function requiredRoleForCommand(c: Command): number {
  if (c.kind === 'PlanImport') {
    return Math.max(REQUIRED_ROLE['file.create'], REQUIRED_ROLE['source.cell.create'])
  }
  // Receipt-only project-lifecycle commands take their OWN prepare/commit path
  // (their role gate is org-level for CreateProject, project-MAINTAINER for
  // UpdateProjectSettings), so this generic per-command floor is never consulted
  // for them — but the union must be covered. MAINTAINER is the honest floor.
  // CreateOrg (AQU-1221) likewise takes its own path: its gate is the
  // credential's SCOPE (unscoped only), not any project role — there is no
  // project, and no org either until it commits. MAINTAINER keeps it aligned
  // with the other tenant-lifecycle command for index filtering; authority.ts
  // and auth-worker's changeset-floor.ts carve it out of the floor rule the
  // same way they carve out CreateProject.
  if (
    c.kind === 'CreateProject' ||
    c.kind === 'CreateOrg' ||
    c.kind === 'UpdateProjectSettings'
  ) {
    return ROLE.MAINTAINER
  }
  // PatchSettings also takes its own path (dynamic per-key floors, incl. the
  // org termbase floor for `terminology`); this static value is the honest
  // index-filtering floor per the command catalog.
  if (c.kind === 'PatchSettings') {
    return staticPatchSettingsFloor(c)
  }
  // SetBrief also takes its own receipt-only path; MAINTAINER is the honest
  // floor (the same one PatchSettings applies to the translationBrief key).
  if (c.kind === 'SetBrief') {
    return SET_BRIEF_REQUIRED_ROLE
  }
  // EmitEvents: max REQUIRED_ROLE across the batch's event kinds — the same
  // floors its compiled events hit at the /events perimeter (dynamic bumps,
  // e.g. foreign unvalidate → maintainer, are enforced in its prepare path).
  if (c.kind === 'EmitEvents') {
    return emitEventsFloor(c)
  }
  if (c.kind === 'LinkMedia') {
    // Compiles to cell.audio.attach + cell.audio.select (both CONTRIBUTOR).
    return Math.max(REQUIRED_ROLE['cell.audio.attach'], REQUIRED_ROLE['cell.audio.select'])
  }
  if (c.kind === 'DraftCells') {
    // Expands at prepare into SetTranslation → target.cell.commit.
    return draftCellsFloor()
  }
  // AQU-1183: the cell-field family. Each command's floor is the max
  // REQUIRED_ROLE across the events it compiles to — PROJECT_LEAD for a source
  // edit (a rung above SetTranslation, matching the UI's source-edit floor),
  // MAINTAINER for a track override. The DYNAMIC bumps (timing lock,
  // allowTrackEditing) are live-state checks in cell-fields-engine.ts.
  if (isCellFieldCommand(c)) {
    return cellFieldsFloor(c)
  }
  // AQU-1185 membership commands: MAINTAINER, flat. Like the other receipt-only
  // kinds they take their own prepare/commit path (which re-checks the grant and
  // target caps live); this is the honest index-filtering floor.
  if (isMembershipCommand(c)) {
    return MEMBERSHIP_FLOOR
  }
  // AQU-1182 RenameFile: desugars to one file.rename event, so its floor IS
  // file.rename's perimeter floor (the UI's own floor for renaming a file).
  if (c.kind === 'RenameFile') {
    return renameFileFloor()
  }
  // AQU-1182 project lifecycle: receipt-only row writes taking their own
  // prepare/commit path, where the floor is re-resolved live. This static value
  // is the honest index-filtering floor (rename MAINTAINER, archive/unarchive
  // OWNER) and mirrors the UI floors for the same actions.
  if (
    c.kind === 'RenameProject' ||
    c.kind === 'ArchiveProject' ||
    c.kind === 'UnarchiveProject'
  ) {
    return projectLifecycleFloor(c)
  }
  // AQU-1235 org-membership commands: like CreateProject these take their own
  // prepare/commit path with an ORG-level gate (owner in the target org), so
  // this generic project floor is never consulted for them. OWNER is the honest
  // value — it keeps them out of every lower role's command index and makes an
  // unreadable-plan authority check fail closed at the same height.
  if (isOrgMemberCommand(c)) {
    return ROLE.OWNER
  }
  // AQU-1228 memory writes compile to no events at all — their floor mirrors
  // auth-worker's agent-memory route (propose = CONTRIBUTOR, retire = the
  // review-tier PROJECT_LEAD). Their own prepare/commit path re-checks it.
  if (isMemoryCommand(c)) {
    return memoryCommandFloor(c)
  }
  // InsertCell / DeleteCell / SplitCell: PROJECT_LEAD, for the same reason
  // EmitEvents floors source.cell.* there — this surface never runs the app's
  // per-event `allowLineCreation` carve-out, so restructuring source rows stays
  // a re-import-shaped act. See commands-structure.ts.
  if (c.kind === 'InsertCell' || c.kind === 'DeleteCell' || c.kind === 'SplitCell') {
    return structureCommandFloor()
  }
  return REQUIRED_ROLE['target.cell.commit']
}
