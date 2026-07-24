export type FileType = "md" | "docx" | "pptx" | "xlsx" | "txt" | "html" | "json" | "po" | "properties" | "vtt" | "srt" | "sbv" | "usfm" | "ebible" | "helloao" | "xliff" | "tmx" | "csv" | "tsv" | "audio" | "video" | "obs" | "sdbh" | "custom"

export type CellType =
  | "text"
  | "heading"
  | "list"
  | "blockquote"
  | "cue"
  | "verse"
  | "paratext"

export interface SourceLocation {
  file: string       // e.g. "word/document.xml", "ppt/slides/slide3.xml"
  blockPath: string  // indexed path to block, e.g. "w:p[2]" or "p:sp[1]/p:txBody/a:p[3]"
}

export interface TranslatableString {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  /** Optional section label for navigation/progress. USFM/ebible set this to "BOOK CHAPTER" (e.g. "GEN 1"). */
  section?: string
  /**
   * Semantic tags external to cell identity. For scripture, the verse ref(s) this cell represents,
   * e.g. ["LUK 1:1"] or ["LUK 1:1", "LUK 1:2"] for a verse range. Mirrors the codex-editor
   * extension's `metadata.data.globalReferences`. Empty/omitted for non-scripture content.
   * Section labels in the sidebar are derived from these when present.
   */
  globalReferences?: string[]
  /** Cue start/end in seconds, parsed from a subtitle timestamp line. Present
   *  only for `type: "cue"` strings from VTT/SRT import; drives `start_ms`/
   *  `end_ms` persistence. */
  start?: number
  end?: number
  /** Speaker extracted from a `<v Name>` VTT voice tag, if present. Maps to a
   *  Cast member on import. */
  speaker?: string
  /** Timeline-segment-model: primary content kind. Absent ⇒ 'text'. Set to
   *  'media' only by the audio/video media-import path (Part B). */
  medium?: "text" | "media"
  /** D1: true on the first cell of a paragraph block. Absent/false = continuation.
   *  Drives paragraph grouping for multi-cell draft operations. */
  paragraphStart?: boolean
  /**
   * Extensible per-cell metadata bucket, mirrored through the import path into
   * `BulkImportCell.metadata` → `source.cell.create` payload → `cells.metadata`
   * (JSONB). OBS populates `{ attachments: [{ type: "image", url, alt }] }` —
   * one frame's reference image per cell. Future attachment kinds (gif/video/
   * audio) reuse the same bucket without a schema change. Absent for content
   * with no attachments.
   */
  metadata?: Record<string, unknown>
  type: CellType
  sourceLocation?: SourceLocation
}

/** File types whose parsers produce scripture-style sections (globalReferences populated, section labels meaningful). */
export const SCRIPTURE_FILE_TYPES: ReadonlySet<FileType> = new Set(["usfm", "ebible", "helloao"])
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
  scope: "project" | "org"
  check: RuleCheck
  enabled: boolean
  createdAt: string
  autofix?: RuleAutofix
  autofixAttemptedAt?: string  // ISO; absent means never tried
  /** For org-scoped rules promoted from a project: the originating project id. */
  sourceProjectId?: string
}

export type RuleCheck =
  | { type: "source-requires-target"; sourcePattern: string; targetPattern: string }
  | { type: "target-forbids"; targetPattern: string }
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

export interface RuleInfraction {
  ruleId: string
  cellId: string
  fileId: string
  message: string
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

export const AUDIO_MEDIA_STRATEGY_LABELS: Record<AudioMediaStrategy, { name: string; description: string }> = {
  stream: {
    name: "Stream",
    description: "Play directly from the network. No local cache, no waveforms unless you opt in.",
  },
  lazy: {
    name: "Lazy (default)",
    description: "Download a cell's audio when you scroll to it or press play. Caches locally.",
  },
  eager: {
    name: "Eager",
    description: "Prefetch every cell's waveform when the file opens. Best for offline review.",
  },
  manual: {
    name: "Manual",
    description: "Don't auto-download anything. You click a button per cell to load it.",
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
}

export interface CellTtsSettings {
  /** Voice from the project's voice library. Falls back to project's defaultVoiceId. */
  voiceId?: string
}

export interface ProjectRecord {
  id: string
  name: string
  /** Owning org id when the project was hydrated from the server. */
  orgId?: number | null
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
  /**
   * AQU-701: set when the user explicitly skips the voice & transcription setup
   * step ("we don't use voice or transcription"). Marks that step complete in
   * the setup checklist so a team that never wants voice/transcription isn't
   * nagged as "not set up". Cleared when they opt back in from the step.
   */
  aiSetupSkipped?: boolean
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
  /** AD-14 decay tunables. Absent → use DECAY_DEFAULTS. */
  decaySettings?: DecaySettings
  /** Required distinct validators for a text cell to count as "fully validated". Clamped [1, 15]. Default 1. Mirrors desktop manifest. */
  validationCount?: number
  /** Required distinct validators for audio. Clamped [1, 15]. Default 1. */
  validationCountAudio?: number
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
   * AQU-186: minimum role to trigger a harmonization sweep on this project.
   * Default (absent) = project_lead (500). Configurable up to maintainer (600).
   * Lowering below project_lead is not allowed (hard floor per spec).
   */
  harmonize_min_role?: "project_lead" | "maintainer"
  /** Cached flag — set true when any cell first writes audio. Avoids scanning every file's Y.Doc on load. */
  hasAnyAudioData?: boolean
  /** When and how to fetch audio bytes from the storage backend. Default: "lazy". */
  audioMediaStrategy?: AudioMediaStrategy
  /** Soft-delete marker. When present the project is in Trash; the Dashboard
   * hides it from "Your projects" and shows it under the Trash section. Set by
   * owner-triggered archive (local projects) or by a sync signal from
   * frontier-server (cloud-synced projects). */
  deletedAt?: string
  /** Display name of whoever archived the project. Populated from frontier-
   * server's response, or from the local session for purely local projects. */
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
}

/** Which key is authoritative for ordering a file's segments. */
export type OrderedBy = "time" | "sequence"

/** Resolve a file's order lens, defaulting absent → 'sequence'. */
export function fileOrderedBy(file: Pick<FileReference, "orderedBy">): OrderedBy {
  return file.orderedBy ?? "sequence"
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
   * How many few-shot examples to retrieve per completion call.
   * Spec key: `top_k`. Default 15.
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
    xlsx: "xlsx",
    txt: "txt",
    html: "html",
    htm: "html",
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
