// The parse-core data types (TranslatableString and friends) live in
// core-types.ts (pure — importable by the parse Web Worker and the sync-worker
// without dragging in this module's deeper workspace type graph). Re-exported
// here so every existing "@/lib/parsers/types" import keeps working unchanged.
export type {
  CellType,
  SourceLocation,
  TranslatableString,
  ParsedTextFileResult,
  ExportCellFields,
} from "./core-types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { PersistedTrackOverrides } from "@/lib/timeline/tracks"
import type { CameraState } from "@/lib/sync/cells-read-types"

/**
 * AQU-997: `"codex"` and `"source"` were reaching the client from the wire long
 * before they were admitted here — `files.fileType` is the server's
 * `kind ?? role`, so a migrated Codex notebook arrives as `"codex"` and a row
 * with no `kind` falls back to its `role`, `"source"`. `cloud-projects.ts`
 * widens both in with `f.type as FileType`, which is exactly why the gap went
 * unnoticed: nothing type-errored, the values simply failed every predicate
 * that tests membership of a literal set.
 */
export type FileType = "md" | "docx" | "pptx" | "idml" | "xlsx" | "txt" | "html" | "epub" | "json" | "po" | "properties" | "vtt" | "srt" | "sbv" | "usfm" | "ebible" | "helloao" | "xliff" | "tmx" | "csv" | "tsv" | "audio" | "video" | "obs" | "sdbh" | "codex" | "source" | "custom"

/** File types whose parsers produce scripture-style sections (globalReferences
 *  populated, section labels meaningful).
 *
 *  AQU-997: `"codex"` — Aquilla's native Scripture notebook format, what every
 *  book of a migrated Codex project is stored as — belongs here for the same
 *  reason `"usfm"` does: its cells are verses, addressed canonically. Its
 *  absence is what hid the Parallel Bibles panel (and its collapsed edge tab,
 *  and file-tree expandability) for a project whose books are all codex files.
 *  `"source"` is deliberately NOT here: it is the generic `role` fallback for
 *  a row carrying no `kind`, not a Scripture format. */
export const SCRIPTURE_FILE_TYPES: ReadonlySet<FileType> = new Set(["usfm", "ebible", "helloao", "codex"])
export function fileTypeHasSections(type: FileType): boolean {
  return SCRIPTURE_FILE_TYPES.has(type)
}

/** Content-aware section capability. `hasScriptureContent` is persisted in
 * the normalized import manifest for Scripture-shaped spreadsheets and custom
 * formats; native Scripture types remain compatible with older records. */
export function fileHasSections(file: Pick<FileReference, "type" | "hasScriptureContent">): boolean {
  return file.hasScriptureContent === true || fileTypeHasSections(file.type)
}

/** AQU-460: true when any project file is a native Scripture type or carries
 * canonical Scripture content in its normalized import manifest. */
export function projectHasScriptureFiles(
  files: Pick<FileReference, "type" | "hasScriptureContent">[] | undefined,
): boolean {
  return (files ?? []).some(fileHasSections)
}

/**
 * AQU-460 derive-on-read: the effective Bible-resources availability for a
 * project. The PERSISTED setting (`explicit`) is written ONLY by an explicit
 * user toggle in Project Settings — nothing writes it on load. When absent,
 * the effective value falls back to whether the project has scripture files,
 * so scripture/Bible projects get Aquifer reference data by default without
 * ever persisting that default. An explicit `false` always wins, even for a
 * scripture project — that's the trust invariant this redesign exists for
 * (a prior load-time auto-enable effect silently overrode explicit OFF).
 *
 * Mirrored server-side in auth-worker/src/lib/aquifer/gate.ts using the native
 * `files.kind` signal plus the normalized import manifest capability.
 */
export function resolveBibleResourcesEnabled(
  explicit: boolean | undefined,
  hasScriptureFiles: boolean,
): boolean {
  return explicit !== undefined ? explicit : hasScriptureFiles
}

export type BuiltinCheckId =
  | "empty-target"
  | "target-equals-source"
  | "placeholder-integrity"
  | "number-integrity"
  | "end-punctuation-mismatch"
  | "punctuation-integrity"
  | "double-space"
  | "repeated-word"
  | "unpaired-symbols"
  | "abbreviation-mismatch"

export interface AlgorithmicCheckOverride {
  enabled: boolean
  /** Omit to use the registry default. */
  severity?: "major" | "minor"
}

export interface TranslationRule {
  id: string
  name: string
  description: string
  severity: "major" | "minor"
  source: "algorithmic" | "llm" | "user"
  scope: "project" | "org" | "lane"
  /** For lane-scoped rules (AQU-609): the target-language lane this rule
   *  applies to. `''` is the project-default lane (matching the cells/lanes
   *  convention from AQU-538). Only meaningful when `scope === "lane"`. */
  lane?: string
  check: RuleCheck
  enabled: boolean
  createdAt: string
  autofix?: RuleAutofix
  autofixAttemptedAt?: string  // ISO; absent means never tried
  /** For org-scoped rules promoted from a project: the originating project id. */
  sourceProjectId?: string
}

export type RuleCheck =
  | { type: "source-requires-target"; sourcePattern: string; targetPattern: string; caseSensitive?: boolean }
  | { type: "target-forbids"; targetPattern: string; caseSensitive?: boolean }
  | { type: "source-target-match"; pattern: string }
  | { type: "builtin"; checkId: BuiltinCheckId }

export type RuleAutofix =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string }

export interface InfractionSpan {
  /** Which side of the cell the match lives on. */
  side: "source" | "target"
  /** Character offset (inclusive) into the plain-text of that side. */
  start: number
  /** Character offset (exclusive). */
  end: number
  /** The matched substring — retained for popover context and debugging. */
  matchedText: string
}

/** A request from a project_lead to promote a project rule to org scope. */
export interface PromotionRequest {
  id: string
  rule: TranslationRule
  sourceProjectId: string
  requestedBy: number
  requestedByName?: string
  requestedAt: string
}

export interface RuleWaiver {
  ruleId: string
  /** Optional human-entered reason. */
  reason?: string
  /** ISO timestamp. */
  waivedAt: string
  /** User id / username, when available. */
  waivedBy?: string
}

/**
 * Which predicate fired. `rule-engine.ts` is a pure, locale-less sync
 * function (called from memos and from the hot keystroke path), so it can't
 * compose a localized sentence itself — it returns a reason CODE instead,
 * and a render-time helper (`formatInfractionReason` /
 * `formatInfractionMessage` in `src/lib/rules/format-infraction.ts`) turns
 * that into text via `t()`. `builtin:${BuiltinCheckId}` covers the ten
 * algorithmic checks; the other three are the user-authored rule shapes.
 */
export type RuleInfractionReason =
  | "target-forbids"
  | "source-requires-target"
  | "source-target-match"
  | `builtin:${BuiltinCheckId}`

export interface RuleInfraction {
  ruleId: string
  cellId: string
  fileId: string
  /** Reason code for the predicate that fired — see `RuleInfractionReason`. */
  reason: RuleInfractionReason
  /**
   * Values substituted into the localized reason text. For
   * `builtin:placeholder-integrity`: `tokens` (the missing placeholder(s),
   * joined) and `count` (how many) — both are RAW content lifted from the
   * cell (via `InfractionSpan.matchedText`) and must never be routed through
   * `t()`, only interpolated as a variable.
   * `source-requires-target`: `sourceCount` and `targetCount` (instance
   * counts as decimal strings).
   */
  reasonParams?: Record<string, string>
  /** Triggering text spans. Empty when the violation has no identifiable
   *  concrete match (e.g. absence rules with no source trigger) — those
   *  fall back to the gutter icon only. */
  spans: InfractionSpan[]
}

export interface RulePenalties {
  major: number  // default 15
  minor: number  // default 5
}

export interface ProjectUsage {
  llmCalls: Record<string, {
    total: number
    byModel: Record<string, number>
    byProvider: Record<string, number>
  }>
  fixesApplied: number
}

export type AudioMediaStrategy =
  /** Stream play directly from the storage URL; only download bytes when the
   *  user opts in to features that need them locally (waveform, transcribe). */
  | "stream"
  /** Default. Download bytes for a cell on first interaction (play OR
   *  waveform mount). Cached locally after that. */
  | "lazy"
  /** On file open, prefetch peaks for every cell with audio so waveforms
   *  appear instantly. Audio bytes for playback come down on first play. */
  | "eager"
  /** Don't auto-download anything. Each cell's waveform shows a download
   *  button the user has to click. */
  | "manual"

// AQU-832: this is a pure lib (no React, no `useT()`) so labels are catalog
// keys a component resolves with `t()` — same "return a descriptor, let the
// caller localize" shape as `roleNameKey()`/`roleDescriptionKey()` in
// src/lib/frontier/roles.ts. Only AudioMediaStrategySection.tsx renders these.
export const AUDIO_MEDIA_STRATEGY_LABELS: Record<AudioMediaStrategy, { nameKey: MessageKey; descriptionKey: MessageKey }> = {
  stream: {
    nameKey: "projectSettings.audioMedia.strategyStreamName",
    descriptionKey: "projectSettings.audioMedia.strategyStreamDescription",
  },
  lazy: {
    nameKey: "projectSettings.audioMedia.strategyLazyName",
    descriptionKey: "projectSettings.audioMedia.strategyLazyDescription",
  },
  eager: {
    nameKey: "projectSettings.audioMedia.strategyEagerName",
    descriptionKey: "projectSettings.audioMedia.strategyEagerDescription",
  },
  manual: {
    nameKey: "projectSettings.audioMedia.strategyManualName",
    descriptionKey: "projectSettings.audioMedia.strategyManualDescription",
  },
}

export type TtsProvider = "omnivoice" | "gemini" | "kokoro" | "mms"

/**
 * A reusable voice in the project's voice library. Voice owns *all* the knobs
 * a user might want to tune (voice id, accent, pronunciation reference,
 * prompt). Project settings hold the API key and the library; per-cell
 * settings just point at one voice by id.
 */
export interface Voice {
  id: string
  name: string
  /** Hex color for the voice's chip/dot in the UI. */
  color?: string
  /** Defaults to "omnivoice" when absent. Kokoro voices ignore everything below voiceName. */
  provider?: TtsProvider
  /** Optional Gemini model override. */
  model?: string
  /** Gemini prebuilt voice id (e.g. "Kore"). For Kokoro, the engine voice name. */
  voiceName?: string
  /** Spoken accent or oral reading tradition. */
  accent?: string
  /** Closest high-resource language whose pronunciation should be used as a fallback. */
  pronunciationReference?: string
  /**
   * Prompt template. Supports {text}, {source}, {target}, {original},
   * {cellLabel}, {context}, {accent}, {pronunciationReference}.
   */
  prompt?: string
  /** Preset voices shipped with the app. Cannot be deleted, only forked. */
  builtIn?: boolean
  /**
   * Voice-clone reference clip id (object name incl. ext) stored project-scoped
   * in R2. When set, TTS output is re-voiced into this clip's timbre via Seed-VC
   * (sync-worker POST /api/v1/voice/convert) before being attached. Absent means
   * plain TTS, no conversion.
   */
  referenceAudioId?: string
  /**
   * When the clone reference was lifted from a line take, `${cellId}:${slot}`
   * of that take. The Reference audio tab is filled only when `referenceAudioId`
   * is set *without* this key (a recorded or uploaded clip).
   */
  referenceTakeKey?: string
}

export interface ProjectTtsSettings {
  /** "omnivoice" (hosted, no key) is the default. "gemini" is BYOK; "kokoro"/"mms" run locally. */
  provider?: TtsProvider
  /** Gemini API key for BYOK TTS. Stored in the local project record. */
  apiKey?: string
  /**
   * Project's voice library. Empty/absent means: use the built-in presets.
   * In the Voice Studio these are presented as the project's *cast* — each
   * voice is a character/speaker (a base TTS voice + an optional actor-clone
   * reference) that lines get assigned to.
   */
  voices?: Voice[]
  /** Voice id used when a cell doesn't specify one (the narrator/default cast member). */
  defaultVoiceId?: string
  /**
   * Persisted line → cast assignment: `cellId → voiceId`. Lets the producer
   * assign every line to a character once (e.g. all of Jesus's lines) and
   * bulk-generate the episode later. Stored in the local project record
   * alongside the rest of the TTS settings; a cell with no entry falls back to
   * `defaultVoiceId`. Keyed by the project-unique cellId, so one map spans all
   * files. Absent for projects that never opened the Studio.
   */
  castAssignments?: Record<string, string>
  /**
   * Character disagreements a person has settled. (AQU-646, 2026-08-18)
   *
   * Keyed `"<textCellId> <cueCellId>"` — the link the decision is about.
   *
   * WHY THIS EXISTS AT ALL. The two character sheets are keyed to opposite
   * sides of the script and sometimes contradict each other. Resolving one
   * writes the winning value to BOTH cells, so no screen is left showing an
   * overruled name — which means the cells afterwards cannot tell you there was
   * ever an argument, or what the losing answer said. This remembers both, so a
   * decision can be re-read and reversed weeks later.
   *
   * Per axis, because one line can disagree about the speaker AND the shot.
   *
   * Stored here rather than as an event kind on purpose: a new kind means two
   * exhaustive test maps plus a sync-worker path `tsc -b` does not check, and
   * this is a note about a judgement, not a change to the script.
   */
  characterResolutions?: Record<string, CharacterResolution>
}

export interface CharacterResolutionChoice<T> {
  /** Which sheet was believed. */
  chose: "subtitle" | "audio"
  /** What the other one said — kept because once both cells agree it exists
   *  nowhere else, and it is the whole basis for reconsidering. */
  rejected: T
}

export interface CharacterResolution {
  name?: CharacterResolutionChoice<string>
  /**
   * AQU-646: `group` joined the three values on 2026-08-20. Records written
   * before that hold `"mixed"` where a fresh import now produces `"group"` —
   * benign, because the self-healing rule in `character-agreement.ts` ignores
   * a record whose rejected value no longer matches the cell.
   */
  camera?: CharacterResolutionChoice<CameraState>
  /** When it was settled, for ordering the resolved list. */
  at: number
}

export interface CellTtsSettings {
  /** Voice from the project's voice library. Falls back to project's defaultVoiceId. */
  voiceId?: string
}

/**
 * AQU-646 SUB-53: which job the Media lens is for.
 *
 * - `"dubbing"` (also the meaning of ABSENT — every project before SUB-53) —
 *   the translation has to fit inside the original's window. The timeline is
 *   drawn against the imported file's clock, a dub that runs past its section
 *   is flagged, and the original plays continuously underneath.
 * - `"audioFirst"` — the translation IS the deliverable and the original is a
 *   reference. Verses are laid out end to end, each taking as much room as its
 *   longer side, so a translation running 2× the original stops reading as a
 *   misalignment. Nothing about the recordings or the imported file changes:
 *   the layout is derived (see lib/timeline/programme.ts), so switching back
 *   reproduces the dubbing view exactly.
 */
export type AudioTimingMode = "dubbing" | "audioFirst"

/** The one place the two modes' user-facing names live — consumed by
 *  TimingModeChangedDialog. Catalog keys, not display strings — `src/lib/`
 *  can't call `useT()`, so the caller resolves them with `t()` at render
 *  time. Reuses the exact same `editor.timeline.timingMode*` keys
 *  `TimelineEditor.tsx`'s `TIMING_MODE_KEYS` table already resolves, so the
 *  two never drift. */
export const AUDIO_TIMING_MODE_LABELS: Record<AudioTimingMode, { nameKey: MessageKey; descriptionKey: MessageKey }> = {
  dubbing: {
    nameKey: "editor.timeline.timingModeDubbing",
    descriptionKey: "editor.timeline.timingModeDubbingHint",
  },
  audioFirst: {
    nameKey: "editor.timeline.timingModeFree",
    descriptionKey: "editor.timeline.timingModeFreeHint",
  },
}

export interface ProjectRecord {
  id: string
  name: string
  /** Owning org id when the project was hydrated from the server. */
  orgId?: number | null
  /**
   * AQU-822: the org's effective `termbaseEditMinRole` — the minimum role
   * allowed to manage this project's termbase (add/edit/delete/archive
   * concepts). Sent by the single-project endpoint so the terminology UI and
   * its settings write share one floor without a second org-settings fetch.
   * Absent (older server / local-only project) ⇒ the PROJECT_LEAD default in
   * `src/lib/terminology/glossary-view.ts`. The server re-resolves it on
   * every terminology write, so this is an affordance value, not authority.
   */
  termbaseEditMinRole?: number | null
  // AQU-1083's org default is NOT here. It lives on the project settings
  // response (`ProjectSettingsResponse.orgCountStructuralCells`), because that
  // is the one an open editor re-reads when someone else changes it.
  /**
   * AQU-1086: the org's effective `languageEditMinRole` — the minimum role
   * allowed to change this project's source/target language and its extra
   * target lanes. Sent by the single-project endpoint so the Project Settings
   * language fields and the Languages card share one floor without a second
   * org-settings fetch. Absent (older server / local-only project) ⇒ the
   * MAINTAINER default in `src/lib/sync/role-policy.ts`. The server
   * re-resolves it on every language write, so this is an affordance value,
   * not authority.
   */
  languageEditMinRole?: number | null
  /**
   * AQU-1002: the org's effective comment floors — the minimum role to open a
   * thread (`commentCreateMinRole`) and to resolve/reopen a thread somebody
   * else opened (`commentResolveMinRole`). Sent by the single-project endpoint
   * so the comments drawer and Comments page can gate their controls honestly
   * without an org-settings fetch of their own. Absent (older server /
   * local-only project) ⇒ the defaults in `src/lib/sync/role-policy.ts`.
   * sync-worker re-resolves both on every comment write, so these are
   * affordance values, not authority.
   */
  commentCreateMinRole?: number | null
  commentResolveMinRole?: number | null
  sourceLanguage: string
  targetLanguage: string
  /**
   * AQU-538: non-default target-language lanes ('' is always implicit, never
   * stored). Overlaid from ProjectWideSettings.targetLanes by useProject's
   * overlaySettings — the workspace LaneSwitcher reads this.
   */
  targetLanes?: string[]
  /**
   * AQU-601: archived lane tags (a subset of `targetLanes`). Overlaid from
   * ProjectWideSettings.archivedLanes; the workspace LaneSwitcher hides these
   * by default (still reachable via the "show archived" reveal / deep links).
   */
  archivedLanes?: string[]
  /** AQU-1271: overlaid from ProjectWideSettings.termMatching by useProject. */
  termMatching?: import("@/lib/terminology/types").TermMatchingSettings
  createdAt: string
  files: FileReference[]
  members: ProjectMember[]
  completionSettings?: CompletionSettings
  ttsSettings?: ProjectTtsSettings
  username?: string
  rules?: TranslationRule[]
  /** Per-project enable/severity overrides for built-in algorithmic checks.
   *  Absent → registry defaults apply. */
  algorithmicChecks?: Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>>
  rulePenalties?: RulePenalties
  origin?: ProjectOrigin
  permissions?: ProjectPermissions
  /**
   * Map: relative path -> SHA-256 of file content as cloned. Used by the
   * serializer to skip non-managed files. Populated only for git-imported
   * projects.
   */
  originalFileListing?: Record<string, string>
  syncSettings?: ProjectSyncSettings
  suggestionsDismissedAt?: string  // ISO timestamp; suggestion banner is hidden after this is set.
  setupChecklistDismissed?: boolean
  /** AQU-1068: who is OFFERED the add and remove actions here? Absent (and
   *  "none") means nobody, whatever their rank. This is a product rule, read
   *  by the editor's affordances rather than enforced at the sync perimeter —
   *  see ProjectWideSettings.cellEditingFloor for the full rationale, and
   *  `resolveCellEditingFloor` for the mapping.
   *
   *  Structurally the same union as `CellEditingTier` in
   *  `@/lib/sync/project-settings`, spelled out rather than imported to keep
   *  this module out of a type cycle with that one. Narrowing it below that
   *  union does not merely drift — `useProject`'s `assign()` copies the synced
   *  value straight into this field, so a rung missing here is a compile
   *  error, which is what keeps the two honest. */
  cellEditingFloor?: "none" | "commenter" | "reviewer" | "contributor" | "project_lead" | "maintainer"
  /** AQU-646 stage 2: may this project's timelines be restructured — tracks
   *  added, deleted, foldered, recoloured? Off unless turned on; a SECOND gate
   *  on top of the maintainer floor, so with it off the write is refused even
   *  to an owner. Rename and drag-to-reorder are NOT gated on it. See
   *  ProjectWideSettings.allowTrackEditing for why switching it off is allowed
   *  to strand tracks that are already there. */
  allowTrackEditing?: boolean
  /**
   * AQU-701: set when the user explicitly skips the voice & transcription setup
   * step ("we don't use voice or transcription"). Marks that step complete in
   * the setup checklist so a team that never wants voice/transcription isn't
   * nagged as "not set up". Cleared when they opt back in from the step.
   */
  aiSetupSkipped?: boolean
  /**
   * Device-local: the user has picked how drafts run on this project
   * (Frontier hosted, a project API key, or a personal override). The
   * sparkle Set up AI dialog shows once until this is true.
   */
  aiProviderChosen?: boolean
  /** ISO timestamp set when the user dismisses the "your project is still using
   * default AI instructions" nudge, OR when they actually customize the system
   * prompt. Either way, we stop nagging. */
  defaultPromptNudgeDismissedAt?: string
  /**
   * Project-scoped toggles for in-development features. Keys are defined in
   * `src/lib/features/flags.ts`; unknown keys are ignored on read. Optional —
   * projects without this field fall back to registry defaults.
   */
  experimentalFlags?: Record<string, boolean>
  /**
   * AQU-1246: project-wide opt-in to the experimental Autopilot surface.
   * Absent/false → no Autopilot UI renders anywhere for this project. Synced
   * (see ProjectWideSettings.autopilotEnabled) rather than device-local, and
   * writable only at project_lead(500)+ — server-enforced in auth-worker.
   * Read through `isAutopilotVisible`, never directly, so the legacy
   * device-local grandfather is honoured with it.
   */
  autopilotEnabled?: boolean
  /** AD-14 decay tunables. Absent → use DECAY_DEFAULTS. */
  decaySettings?: DecaySettings
  /** Required distinct validators for a text cell to count as "fully validated". Clamped [1, 15]. Default 1. Mirrors desktop manifest. */
  validationCount?: number
  /** Required distinct validators for audio. Clamped [1, 15]. Default 1. */
  validationCountAudio?: number
  /**
   * AQU-1083: does this project count structural cells — chapter headings,
   * section titles, book names — as translatable content in its progress and
   * completion numbers?
   *
   * ABSENT means "use the organization's default", which is the third state of
   * the control. There is deliberately no stored value for it: a null would be
   * a third thing the resolver has no meaning for. Absent on the org too means
   * they count, which is what every project did before this existed.
   */
  countStructuralCells?: boolean
  /**
   * Minimum role level required to cast a validation vote.
   * "reviewer" (default) | "project_lead" | "maintainer"
   * Server enforcement: sync-worker cell.validate branch must check the
   * validator's syncRole.level against the floor before accepting the event.
   * SWARM-TODO(server-enforcement): apply validationRoleFloor in
   *   sync-worker/src/routes/sync.ts — the cell.validate event-projection
   *   branch. Fetch the validator's role from the project member list (or
   *   the sync-token claim) and reject if role.level < floor.
   */
  validationRoleFloor?: "reviewer" | "project_lead" | "maintainer"
  /**
   * Optional allowlist of usernames that may cast validation votes.
   * When present AND non-empty, only listed users' votes count toward the
   * threshold (AND'd with validationRoleFloor).
   * SWARM-TODO(server-enforcement): apply validationNamedUsers in
   *   sync-worker/src/routes/sync.ts — cell.validate branch. If list is
   *   non-empty, reject votes from users not in the list.
   */
  validationNamedUsers?: string[]
  /**
   * When true (default), a contributor may validate their own commit and
   * the vote counts toward the threshold.
   * When false, self-votes are silently ignored in threshold counting.
   * SWARM-TODO(server-enforcement): apply allowSelfValidation in
   *   sync-worker/src/routes/sync.ts — cell.validate branch. Compare
   *   validator identity to the last-editor identity; skip if equal and
   *   allowSelfValidation is false.
   */
  allowSelfValidation?: boolean
  /**
   * AQU-490: the audio twins of the three above. SEPARATE keys, by Sam's
   * ruling — a project can want two ears on a recording and one on a
   * translation, or trust a different set of people with each. Neither set is
   * ever read as a fallback for the other; absent means unrestricted on both
   * sides. All three ARE enforced server-side (sync-worker route.ts), unlike
   * the text trio's long-standing SWARM-TODOs.
   */
  validationRoleFloorAudio?: "reviewer" | "project_lead" | "maintainer"
  validationNamedUsersAudio?: string[]
  allowSelfValidationAudio?: boolean
  /**
   * AQU-186: minimum role to trigger a harmonization sweep on this project.
   * Default (absent) = project_lead (500). Configurable up to maintainer (600).
   * Lowering below project_lead is not allowed (hard floor per spec).
   */
  harmonize_min_role?: "project_lead" | "maintainer"
  /** Cached flag — set true when any cell first writes audio. Avoids scanning every file's Y.Doc on load. */
  hasAnyAudioData?: boolean
  /**
   * AQU-646 SUB-53: which job the Media lens is for — "dubbing" (the
   * translation must fit the original's window; absent means this) or
   * "audioFirst" (the translation is the deliverable, so verses are laid out
   * end to end at their real lengths). Overlaid from
   * ProjectWideSettings.audioTimingMode by useProject's overlaySettings.
   */
  audioTimingMode?: AudioTimingMode
  /**
   * AQU-646: is the timeline locked against chip dragging? Overlaid from
   * ProjectWideSettings.timingLocked by useProject's overlaySettings.
   *
   * ABSENT MEANS LOCKED — see `resolveTimingLocked` in lib/sync/project-settings
   * for why this one setting inverts the file's usual convention. Read it
   * through that resolver rather than testing this field directly, so a project
   * whose settings have not arrived yet errs toward frozen rather than
   * briefly handing everyone the handles.
   */
  timingLocked?: boolean
  /** When and how to fetch audio bytes from the storage backend. Default: "lazy". */
  audioMediaStrategy?: AudioMediaStrategy
  /** Soft-delete marker. When present the project is in Trash; the Dashboard
   * hides it from "Your projects" and shows it under the Trash section. Set by
   * owner-triggered archive (local projects) or by a sync signal from
   * auth-worker (cloud-synced projects). */
  deletedAt?: string
  /** Display name of whoever archived the project. Populated from
   * auth-worker's response, or from the local session for purely local projects. */
  deletedBy?: string
  /**
   * Active/inactive lifecycle state (migration 0033, AQU-214).
   * Absent or true = active (normal, editable). false = inactive (frozen).
   * Inactive projects are visible in the list but block edits until reactivated.
   * DISTINCT from deletedAt (Trash): inactive keeps the project in the normal
   * listing (with a filter) while Trash hides it entirely.
   */
  isActive?: boolean
  /**
   * AD-9: upstream source project id for linked-target projects. Null / absent
   * means this project is self-contained (or is itself a source). Set by the
   * auth-worker's /link-source endpoint; cleared by /detach-source.
   */
  sourceProjectId?: string | null
  /** AQU-476/478: link mode/consumes/gate/cursor — see CloudProjectSummary
   *  for field semantics. Populated alongside sourceProjectId. */
  sourceLinkMode?: "clone" | "live" | null
  sourceLinkConsumes?: "source" | "target" | null
  sourceLinkGate?: "head" | "validated" | null
  sourceLinkCursor?: number | null
  /** Cached sync role from the most recent /sync-token response. Lets the
   * Dashboard show the owner-only "Move to Trash" action without a round-trip
   * per card. Stale values are tolerable — server re-validates on every
   * archive call. */
  syncRole?: {
    level: number
    name: string
    source: string
    fetchedAt: string
  }
  usage?: ProjectUsage
  /** Project terminology / glossary concepts. Persisted and synced via
   *  ProjectWideSettings (same mechanism as `rules`). Active concepts are
   *  compiled to TranslationRule instances at rule-evaluation time — violations
   *  are DERIVED on read, no materialized verdicts. */
  terminology?: import("@/lib/terminology/types").Concept[]
  /** Authored living-memory entries (instructions + standards). Persisted and
   *  synced via ProjectWideSettings the same way as `rules` / `terminology`. */
  livingMemoryEntries?: LivingMemoryEntry[]
  /** The project's skopos/Paratext translation brief. Persisted and synced via
   *  ProjectWideSettings the same way as `livingMemoryEntries`. */
  translationBrief?: import("@/lib/brief/types").TranslationBrief
  /**
   * Persisted interlinear alignment seeds (AQU-207). Synced via
   * ProjectWideSettings the same way as `terminology`. Positive weight =
   * confirmed, negative = invalidated. Feeds back into buildAlignmentModel as
   * pseudo-count seeds so subsequent statistical BT/alignment reflects them.
   */
  alignmentSeeds?: import("@/lib/completion/interlinear").AlignmentSeed[]
  /** Bible Aquifer reference data (bibletranslation.org). Synced via
   *  ProjectWideSettings. This is the EXPLICIT user override only — absent
   *  means "no explicit choice yet". Do not read this field directly for
   *  gating; use `resolveBibleResourcesEnabled(explicit, hasScriptureFiles)`
   *  (AQU-460 derive-on-read: unset defaults to on for scripture projects,
   *  never persisted just by opening/viewing). Gates the Search-dock "Bible
   *  resources" mode and the agent's aquifer branch. */
  bibleResourcesEnabled?: boolean
  /** AI-draft context budget. Synced via ProjectWideSettings; absent →
   *  DEFAULT_DRAFT_CONTEXT applies. See D10 in paragraph-drafting spec. */
  draftContext?: import("@/lib/completion/draft-context").DraftContextSettings
  /** AQU-634: when true, USFM imports exclude book-name/title/TOC + intro-block
   *  front matter (per-project opt-out). Synced via ProjectWideSettings; absent/
   *  false imports front matter as translatable cells. */
  importExcludeFrontMatter?: boolean
}

/** A single authored guidance entry in the Living Memory page. */
export interface LivingMemoryEntry {
  id: string
  kind: "instruction" | "standard"
  text: string
  createdAt: string
  author: string
}

export interface ProjectSyncSettings {
  autoSync: { enabled: boolean; intervalMinutes: number }
}

export interface FileReference {
  id: string
  name: string
  type: FileType
  createdAt: string
  cellCount: number
  corpusMarker?: string  // From notebook metadata.corpusMarker, OT/NT fallback for biblical book stems
  originalName?: string  // Set the first time `name` is auto-rewritten by a suggestion or user rename. Enables hover-to-see-original. Never overwritten after set.
  /** Stable USFM/Scripture book identity used for re-import collision matching. */
  bookCode?: string
  /** Content capability derived from canonical import addresses. This is
   * intentionally separate from `type`, which remains the real source format
   * used for re-import and round-trip export. */
  hasScriptureContent?: boolean
  /**
   * Display lens for this file's segments (timeline-segment-model, Scope A).
   * `'time'`   → rows sort by timing start (sequenceIndex breaks ties / homes
   *              untimed rows); the timeline is the spine. Subtitle/audio/video.
   * `'sequence'` → rows sort by intrinsic `sequenceIndex` (e.g. verse order);
   *              timing is metadata. Text-first translation / audio Bible.
   * Absent → treated as `'sequence'` (see `fileOrderedBy`). Toggling this NEVER
   * mutates cell data — it only chooses the sort key. Fully reversible.
   */
  orderedBy?: OrderedBy
  /** Optional file-level language hints from import metadata. */
  sourceLanguage?: string
  targetLanguage?: string
  /** Optional file-level text direction hints from import metadata. */
  sourceTextDirection?: "ltr" | "rtl"
  targetTextDirection?: "ltr" | "rtl"
  /**
   * Timeline editor: core video URL for the preview / master clock. Stored in
   * files.meta JSON (set via the `file.video.set` event). Absent ⇒ no video.
   */
  coreMediaUrl?: string | null
  /**
   * The file's audio timing mode (pre-merge round: a FILE-level distinction —
   * the video link it interacts with is per-file too). Stored in files.meta
   * JSON (set via the `file.timing.set` event). Absent ⇒ the project-level
   * default applies (see `resolveFileTimingMode`).
   */
  timingMode?: AudioTimingMode | null
  /**
   * What the audio-VTT import did about drift, for an audio-cue sibling:
   * `scale` 1.001 means the cues were stretched to match the reference, and the
   * fps labels are present only when both rates could actually be named. Read
   * from `meta.aquillaImport.audioVtt.timebase`; absent on every other file.
   * The project report turns this into "corrected" / "aligned" / "not
   * measurable" so an episode's timing can be signed off rather than assumed.
   */
  audioVttTimebase?: { fromFps?: string; toFps?: string; scale: number } | null
  /**
   * Persisted per-track DELTAS keyed by track id — renames, reorders, groups,
   * and the entries that bring user-added tracks into existence. Stored in
   * files.meta JSON (set via the `file.track.set` event). Absent ⇒ the pure
   * derived defaults.
   *
   * This is NEVER the full track list, which is exactly why the field is not
   * called `tracks`. Consume it ONLY through `mergeTrackOverrides` (via
   * `deriveTracksForFile`) — that is the one place that knows which deltas are
   * applicable and which belong to a build newer than this one.
   */
  trackOverrides?: PersistedTrackOverrides | null
  /**
   * AQU-656: true when this file has an original import blob. Set on
   * document imports that uploaded source bytes; absent/false otherwise
   * (audio/video, Codex-migrated, pre-sidecar).
   */
  hasOriginalSource?: boolean
  /**
   * The files-table `role` column. `"source"` for every ordinary import — the
   * value that matters is `"audio-cues"` (see `AUDIO_CUES_ROLE`), which marks a
   * hidden timeline-only sibling. Deliberately NOT folded into `type`: the
   * sibling's `type` is "vtt" like any other subtitle import, so `role` is the
   * only thing that tells them apart. Absent on files whose server row predates
   * the column, or that were never sent a role.
   */
  role?: string
  /**
   * The file this one annotates (`files.anchor_file_id`) — for an audio-cue
   * sibling, the text file whose timeline carries its cues. The sibling appears
   * in no file list, so this is the only route back to it. Absent on ordinary
   * files.
   */
  anchorFileId?: string
}

/** Which key is authoritative for ordering a file's segments. */
export type OrderedBy = "time" | "sequence"

/** Resolve a file's order lens, defaulting absent → 'sequence'. */
export function fileOrderedBy(file: Pick<FileReference, "orderedBy">): OrderedBy {
  return file.orderedBy ?? "sequence"
}

/**
 * True for the formats whose cues arrive already timed against someone else's
 * video. The canonical predicate — "is this a subtitle import?" gets ONE answer
 * across the app, because the hand-rolled `vtt || srt` check this replaces
 * (ProjectWorkspace) missed `sbv`, which imports to exactly the same timed cues
 * as the other two.
 *
 * Takes a plain `type` string rather than a `FileType`, because half the
 * callers hold one: the export dialog carries `activeFileType?: string | null`
 * and kept its own `vtt || srt` copy — missing `sbv` all over again — purely
 * because this signature would not accept it (2026-08-20). A predicate that
 * compares three literals has no business demanding a narrower input than the
 * places that need to ask.
 */
export function isSubtitleImportFile(
  file: { type?: string | null } | null | undefined,
): boolean {
  return file?.type === "vtt" || file?.type === "srt" || file?.type === "sbv"
}

/**
 * `role` of the audio-cue sibling: a file holding ONLY the cues of an episode's
 * audio VTT (~550 near-verbatim transcript lines timing the film's own
 * soundtrack), paired to its text file through `anchorFileId`.
 *
 * Why a whole separate file instead of extra cells on the text file: `medium`
 * is the app's ONLY cell→surface discriminator, and audio cues are text. Put
 * them in the text file and those 550 rows land in the dialogue table, in
 * `files.cell_count`, in the validation percentages, in every export, and in
 * project search — none of which has a lever to exclude them. A sibling
 * isolates all of it at once, and the pieces that must see the cues (the
 * timeline's Source-audio row) reach it explicitly by id.
 */
export const AUDIO_CUES_ROLE = "audio-cues"

/**
 * True for that sibling. The canonical predicate — every surface that lists,
 * counts, searches, or exports project files has to hide it, so "is this an
 * audio-cue file?" gets ONE answer, exactly like `isSubtitleImportFile`.
 */
export function isAudioCueFile(file: Pick<FileReference, "role"> | null | undefined): boolean {
  return file?.role === AUDIO_CUES_ROLE
}

/**
 * Resolve a file's audio timing mode: Original timing for every subtitle import
 * (see below), else the file's own choice, else the project-level value (the
 * legacy Project Settings field, kept as a read-only fallback so pre-existing
 * projects keep the mode they had chosen), else Original timing. Mixed-mode
 * projects are allowed by design.
 */
export function resolveFileTimingMode(
  file: Pick<FileReference, "timingMode" | "type"> | null | undefined,
  project: Pick<ProjectRecord, "audioTimingMode"> | null | undefined,
): AudioTimingMode {
  // AQU-646: Free timing does not exist for subtitle imports — their cues are
  // already timed to a video, so laying them end to end has nothing to fit.
  // Withdrawing it at RESOLUTION rather than from the picker is the whole
  // point: hiding the control would have left three ways back in. (a) The
  // file's own stored `timingMode`, written before the mode was withdrawn.
  // (b) Inheritance from the LEGACY project-level `audioTimingMode` below — a
  // VTT nobody has ever touched still resolves to Free timing off a project
  // setting made back when the control lived in Project Settings. (c) A
  // `file.timing.set` from an OLDER client that still offers the mode; the
  // server deliberately keeps accepting it, since rejecting it would break
  // those clients for no gain. A stray "audioFirst" on a subtitle file is
  // simply inert from here on — nothing migrates it away.
  if (isSubtitleImportFile(file)) return "dubbing"
  if (file?.timingMode === "audioFirst" || file?.timingMode === "dubbing") return file.timingMode
  // Only "audioFirst" opts out of the original behaviour — anything else,
  // including a value the settings blob happens to carry (the server accepts
  // arbitrary top-level keys), reads as Original timing. Same normalization
  // as resolveAudioTimingMode, inlined to keep this module import-free.
  return project?.audioTimingMode === "audioFirst" ? "audioFirst" : "dubbing"
}

export interface ProjectMember {
  userId: string
  role: "owner" | "translator" | "reviewer"
}

export type CompletionProvider = "frontier" | "custom"

export type ContextSize = "small" | "medium" | "large"

export interface CompletionSettings {
  provider?: CompletionProvider // "frontier" (default, uses api.frontierrnd.com) or "custom" (self-hosted, local, or third-party OpenAI-compatible endpoint like OpenRouter, OpenAI, Groq, etc.)
  endpoint: string              // only used when provider === "custom". Base URL (e.g. "http://localhost:8000" or "https://openrouter.ai/api/v1"). Trailing "/v1" or "/chat/completions" is tolerated and normalized.
  apiKey?: string               // only used when provider === "custom". Sent as "Authorization: Bearer <key>". Leave blank for unauthenticated local endpoints.
  model: string                 // blank = provider's default (e.g. Frontier picks DEFAULT_LLM_MODEL server-side)
  maxTokens: number
  temperature: number
  /**
   * Alias: spec calls this `chatSystemMessage`. Renamed `systemPrompt` here for
   * internal clarity; the two names refer to the same concept.
   */
  systemPrompt: string
  /** 0-1, default 0.1. Only consumed by the legacy health engine (flag-off path). Will be removed once the composite-health flag is default-on. */
  llmHealthPenalty?: number

  // ── v1 AI retrieval-tuning settings (spec: ai-copilot.md config table) ────

  /**
   * Total approved few-shot example budget per completion call.
   * Spec key: `top_k`. Default 10 for Luna.
   */
  top_k?: number

  /**
   * Controls how much surrounding passage context is included.
   * "small" = tight window, "medium" = paragraph (default), "large" = chapter.
   * Spec key: `contextSize`.
   */
  contextSize?: ContextSize

  /**
   * Legacy compatibility key. Production drafting always restricts few-shot
   * examples to approved (`status === "validated"`) cells; false values from
   * older project settings are ignored.
   * Spec key: `useOnlyValidatedExamples`. Effective value: true.
   */
  useOnlyValidatedExamples?: boolean

  /**
   * Language the AI assistant uses in chat responses, independent of the
   * project's UI locale. Spec key: `main_chat_language`.
   * Label in UI: "Assistant language".
   */
  main_chat_language?: string

  /**
   * Controls how few-shot examples are rendered in the prompt.
   * "source-and-target" (default): each example shows both the source and
   * target text, aligned as source→translation pairs.
   * "target-only": only the target text of each example is shown; the system
   * prompt is augmented with a note that the examples are reference
   * translations to imitate for style/patterns.
   */
  fewShotExampleFormat?: "source-and-target" | "target-only"

  /**
   * AQU-586: how many untranslated cells the "Run AI completions" action drafts
   * per package. `undefined`/0 falls back to MAX_BATCH_COMPLETIONS (10). Larger
   * files are advanced by running the next package. Clamped 1–50 at the UI.
   */
  completionBatchSize?: number

  /**
   * AQU-586: cap on how many eligible cells a single "Batch validate" action
   * processes. `undefined`/0 = validate all eligible cells (default, unchanged
   * behavior); a positive value validates only the first N eligible cells so a
   * reviewer can approve in bounded batches. Clamped 0–500 at the UI.
   */
  validationBatchSize?: number
}

export interface WeightedExample {
  cellId: string
  /** Coverage weight at generation time, in [0, 1]. Larger = example covered more of the source query. */
  weight: number
}

export interface CellHistoryEntry {
  timestamp: string
  value: string
  /** Rich target/source snapshot for formats whose structural HTML is part of
   *  the round-trip contract (IDML v2) and for ordinary rich-text history. */
  valueHtml?: string
  source: "human" | "llm"
  author: string
  validated: boolean
  /**
   * Example cells used at generation time. Legacy entries store `string[]`
   * (cell IDs, unweighted); new entries store `WeightedExample[]`. The
   * composite-health scorer treats legacy entries as unknown lineage.
   */
  examples?: string[] | WeightedExample[]
  /**
   * AD-2 chain pointer. Present when the entry came from D1 (per-cell history
   * endpoint); absent for legacy Y.Doc-derived entries. Used by the history
   * drawer to distinguish chain-winning commits from stale branches and to
   * surface a "promote this version" affordance.
   */
  eventId?: string
  /**
   * True when this commit lost the AD-2 first-child-of-parent race for its
   * `parent_id` slot — the event is durably logged but never advanced the
   * cell's projection. Computed by walking back from the cell's current
   * chain head; everything not on that walk is a stale branch.
   */
  isStale?: boolean
  /** Local outbox state; absent once the server history has acknowledged it. */
  syncState?: "pending" | "failed"
}

export interface CommentMessage {
  id: string
  author: string
  authorType: "user" | "anonymous"
  text: string
  timestamp: string
  mentions?: string[]
}

export interface CommentThread {
  id: string
  status: "open" | "resolved"
  createdAt: string
  resolvedAt?: string
  resolvedBy?: string
  /**
   * AQU-692: snapshot of the target text when the thread was created, used to
   * decide the "Translation changed since this thread was created" badge.
   * `null` = unknown baseline (legacy thread or git-imported) → never stale.
   */
  createdForTranslated: string | null
  /**
   * AQU-1000: username of whoever started the thread, matching the server's
   * `comments.author_id`. Resolve carries a higher role floor on a thread you
   * did not write, so the UI needs the identity — not just the display label
   * on `messages[0].author` — to decide whether to offer the control.
   * `undefined` for git-imported / legacy threads that never carried one.
   */
  authorId?: string
  messages: CommentMessage[]
}

export interface SnapshotFile {
  fileId: string
  fileName: string
  fileType: FileType
  /** @deprecated v2-era field; no longer written or read. Kept optional for
   *  backward-compat deserialization of old snapshots. */
  ydocState?: string
}

export interface ProjectSnapshot {
  id: string
  projectId: string
  name: string
  description?: string
  createdAt: string
  createdBy: string
  automatic: boolean
  schemaVersion?: number  // NEW — omitted/1 = pre-M9, 2 = M9+
  files: SnapshotFile[]
  projectRecord: ProjectRecord
}

export interface VideoAttachment {
  videoUrl?: string
  videoLocalFileId?: string
  videoFileName?: string
  // Seconds to shift cue-space relative to raw video time. Example: if the
  // video has 5s of intro before subtitles should start, set to 5 — a cue at
  // "00:00:01" will display at video time 6s.
  videoStartOffset?: number
}

export interface ProjectOrigin {
  kind: "git"
  cloneUrl: string
  gitlabProjectId: number
  branch: string
  headSha: string
  importedAt: string
}

export interface ProjectPermissions {
  source: "gitlab" | "local"
  canEditContent: boolean
  canEditComments: boolean
  canResolveComments: boolean
  canPush: boolean
  accessLevel?: number
}

export function detectFileType(fileName: string): FileType | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
  const map: Record<string, FileType> = {
    md: "md",
    markdown: "md",
    docx: "docx",
    pptx: "pptx",
    idml: "idml",
    xlsx: "xlsx",
    txt: "txt",
    html: "html",
    htm: "html",
    epub: "epub",
    json: "json",
    arb: "json",
    po: "po",
    pot: "po",
    properties: "properties",
    vtt: "vtt",
    srt: "srt",
    sbv: "sbv",
    usfm: "usfm",
    sfm: "usfm",
    usx: "usfm",
    xlf: "xliff",
    xliff: "xliff",
    tmx: "tmx",
    csv: "csv",
    tsv: "tsv",
    // Timeline-segment-model: audio/video files import as a single media
    // segment on a time-ordered file (no text parser — opaque media blob).
    mp3: "audio",
    wav: "audio",
    m4a: "audio",
    aac: "audio",
    flac: "audio",
    ogg: "audio",
    oga: "audio",
    opus: "audio",
    mp4: "video",
    m4v: "video",
    mov: "video",
    webm: "video",
    mkv: "video",
  }
  return map[ext || ""] || null
}

/** True for file types that are opaque media blobs (no text parser). */
export function isMediaFileType(t: FileType): boolean {
  return t === "audio" || t === "video"
}

export interface DecaySettings {
  /**
   * @deprecated AD-14 amendment 2026-06-04 retired endorsement_count. Use
   * `maxHops` to tune the graph-confidence radius instead.
   * Still read for backwards-compat on existing saved settings; ignored when
   * a server confidence rollup is available.
   */
  endorsementTarget?: number
  /** Decay above which the cell editor shows "needs attention". Default 0.66. */
  decayWarnThreshold?: number
  /**
   * AD-14 health-as-confidence: per-hop authority decay used when health ripples
   * out from validated cells through the example graph. Lower = confidence fades
   * faster with distance from a human. Default 0.8.
   */
  perHopDecay?: number
  /**
   * AD-14 amendment 2026-06-04: max propagation radius (hops from a validated
   * anchor). Bounds the recursive graph traversal. Default 4.
   */
  maxHops?: number
}
