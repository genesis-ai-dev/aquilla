export type FileType = "md" | "docx" | "pptx" | "txt" | "vtt" | "srt" | "usfm" | "ebible"

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
  type: CellType
  sourceLocation?: SourceLocation
}

/** File types whose parsers produce scripture-style sections (globalReferences populated, section labels meaningful). */
export const SCRIPTURE_FILE_TYPES: ReadonlySet<FileType> = new Set(["usfm", "ebible"])
export function fileTypeHasSections(type: FileType): boolean {
  return SCRIPTURE_FILE_TYPES.has(type)
}

export type BuiltinCheckId =
  | "empty-target"
  | "target-equals-source"
  | "placeholder-integrity"
  | "number-integrity"
  | "end-punctuation-mismatch"
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

export type TtsProvider = "kokoro" | "gemini" | "mms"

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
  /** Defaults to "gemini" when absent. Kokoro voices ignore everything below voiceName. */
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
}

export interface ProjectTtsSettings {
  /** "gemini" is the recommended BYOK default. "kokoro" keeps the local browser model path. */
  provider?: TtsProvider
  /** Gemini API key for BYOK TTS. Stored in the local project record. */
  apiKey?: string
  /** Project's voice library. Empty/absent means: use the built-in presets. */
  voices?: Voice[]
  /** Voice id used when a cell doesn't specify one. */
  defaultVoiceId?: string
}

export interface CellTtsSettings {
  /** Voice from the project's voice library. Falls back to project's defaultVoiceId. */
  voiceId?: string
}

export interface ProjectRecord {
  id: string
  name: string
  sourceLanguage: string
  targetLanguage: string
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
  /** @deprecated Four-sub-score health config — retired by AD-14 (decay). */
  healthSettings?: HealthSettings
  /** AD-14 decay tunables (endorsementTarget, decayWarnThreshold). Absent → DECAY_DEFAULTS. */
  decaySettings?: DecaySettings
  /** Required distinct validators for a text cell to count as "fully validated". Clamped [1, 15]. Default 1. Mirrors desktop manifest. */
  validationCount?: number
  /** Required distinct validators for audio. Clamped [1, 15]. Default 1. */
  validationCountAudio?: number
  /** Cached flag — set true when any cell first writes audio. Avoids scanning every file's Y.Doc on load. */
  hasAnyAudioData?: boolean
  /** When and how to fetch audio bytes from the storage backend. Default: "lazy". */
  audioMediaStrategy?: AudioMediaStrategy
  /** Soft-delete marker. When present the project is in Trash; the Dashboard
   * hides it from "Your projects" and shows it under the Trash section. Set by
   * owner-triggered archive (local projects) or by a sync signal from
   * identity (cloud-synced projects). */
  deletedAt?: string
  /** Display name of whoever archived the project. Populated from frontier-
   * server's response, or from the local session for purely local projects. */
  deletedBy?: string
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
  /** AD-9 source-project link (Phase 5). Self-FK to another project the
   *  source-side cells are read from. Null / undefined = self-contained
   *  or source-only (those two shapes are distinguished by `targetLanguage`).
   *  Populated when the auth-worker's project endpoints start surfacing
   *  the column; absent until then. */
  sourceProjectId?: string | null
  /** Optional display name of the upstream — purely cosmetic, populated
   *  when known (e.g. from the user's accessible projects list). */
  sourceProjectName?: string
  usage?: ProjectUsage
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
}

export interface ProjectMember {
  userId: string
  role: "owner" | "translator" | "reviewer"
}

export type CompletionProvider = "frontier" | "custom"

export interface CompletionSettings {
  provider?: CompletionProvider // "frontier" (default, uses api.frontierrnd.com) or "custom" (self-hosted, local, or third-party OpenAI-compatible endpoint like OpenRouter, OpenAI, Groq, etc.)
  endpoint: string              // only used when provider === "custom". Base URL (e.g. "http://localhost:8000" or "https://openrouter.ai/api/v1"). Trailing "/v1" or "/chat/completions" is tolerated and normalized.
  apiKey?: string               // only used when provider === "custom". Sent as "Authorization: Bearer <key>". Leave blank for unauthenticated local endpoints.
  model: string                 // blank = provider's default (e.g. Frontier picks DEFAULT_LLM_MODEL server-side)
  maxTokens: number
  temperature: number
  systemPrompt: string
  /** 0-1, default 0.1. Only consumed by the legacy health engine (flag-off path). Will be removed once the composite-health flag is default-on. */
  llmHealthPenalty?: number
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
  createdForTranslated: string
  messages: CommentMessage[]
}

export interface SnapshotFile {
  fileId: string
  fileName: string
  fileType: FileType
  ydocState: string  // base64 encoded Y.encodeStateAsUpdate output
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

// ─── Health settings (composite-health flag) ────────────────────────────

export interface HealthCaps {
  validationGap: number
  ancestryPenalty: number
  neighborhoodPenalty: number
  rulePenalty: number
}

export interface HealthRulePenaltiesConfig {
  major: number
  minor: number
}

export interface NeighborhoodWeights {
  idJaccard: number
  tfidfTokenOverlap: number
}

export interface HealthConfig {
  caps: HealthCaps
  rulePenalties: HealthRulePenaltiesConfig
  neighborhoodWeights: NeighborhoodWeights
  neighborhoodSearchLimit: number
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface HealthSettings {
  /** When true, ignore `overrides` and always use HEALTH_DEFAULTS. */
  followDefaults: boolean
  /** Partial override of HEALTH_DEFAULTS, merged at resolution time. */
  overrides?: DeepPartial<HealthConfig>
}

/**
 * AD-14 decay tunables (persisted in project_settings; both keys optional —
 * absent keys fall back to DECAY_DEFAULTS in the decay engine).
 */
export interface DecaySettings {
  /** Endorsement count at which a cell reaches decay = 0. Default 5. */
  endorsementTarget?: number
  /** Decay above which the cell editor shows "needs attention". Default 0.66. */
  decayWarnThreshold?: number
}

export interface CellHealthBreakdown {
  cellId: string
  score: number
  validationGap: number
  ancestryPenalty: number
  neighborhoodPenalty: number
  rulePenalty: number
  signals: {
    validatorCount: number
    requiredValidations: number
    ancestryExamples: Array<{ cellId: string; health: number; weight: number }>
    neighborhoodSourceCellIds: string[]
    neighborhoodTargetCellIds: string[]
    idJaccard: number
    tfidfTokenOverlap: number
    infractions: RuleInfraction[]
  }
}

export function detectFileType(fileName: string): FileType | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
  const map: Record<string, FileType> = {
    md: "md",
    markdown: "md",
    docx: "docx",
    pptx: "pptx",
    txt: "txt",
    vtt: "vtt",
    srt: "srt",
    usfm: "usfm",
    sfm: "usfm",
  }
  return map[ext || ""] || null
}
