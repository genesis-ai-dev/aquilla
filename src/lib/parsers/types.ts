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
  /** Optional section label for navigation/progress. USFM/ebible set this to "BOOK CHAPTER" (e.g. "GEN 1"). When present, takes precedence over `group` for sectioning UI. */
  section?: string
  type: CellType
  sourceLocation?: SourceLocation
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
}

export type RuleCheck =
  | { type: "source-requires-target"; sourcePattern: string; targetPattern: string }
  | { type: "target-forbids"; targetPattern: string }
  | { type: "source-target-match"; pattern: string }

export interface RuleInfraction {
  ruleId: string
  cellId: string
  fileId: string
  message: string
}

export interface RulePenalties {
  major: number  // default 15
  minor: number  // default 5
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
  username?: string
  rules?: TranslationRule[]
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
   * Project-scoped toggles for in-development features. Keys are defined in
   * `src/lib/features/flags.ts`; unknown keys are ignored on read. Optional —
   * projects without this field fall back to registry defaults.
   */
  experimentalFlags?: Record<string, boolean>
  /** Caps and knobs for the composite-health scorer. Absent → use HEALTH_DEFAULTS. */
  healthSettings?: HealthSettings
  /** Required distinct validators for a text cell to count as "fully validated". Clamped [1, 15]. Default 1. Mirrors desktop manifest. */
  validationCount?: number
  /** Required distinct validators for audio. Clamped [1, 15]. Default 1. */
  validationCountAudio?: number
  /** Cached flag — set true when any cell first writes audio. Avoids scanning every file's Y.Doc on load. */
  hasAnyAudioData?: boolean
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

export interface ShareInvite {
  token: string
  projectId: string
  pinHash?: string
  createdAt: string
  createdBy: string
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
