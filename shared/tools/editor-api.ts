/**
 * Smart Extensions bridge, apiRev 3: the shapes an `editor` extension reads
 * to carry the whole editing experience — the host's editor configuration,
 * chapter/section paging, per-cell signals (staleness, assignments,
 * repetition, rule issues, health, AI drafting state, back-translations),
 * key-term matches, collaborators' live presence, suggestions and the bulk
 * selection. Shared by the SPA host (handlers + live data), the smoke stub and
 * the builder prompt. Everything here is ADDITIVE over apiRev 2.
 *
 * Heavy features stay host-owned: AI drafting (credits, evidence, the model),
 * back-translation, rules/health computation, the history drawer, comments,
 * attachments, recording/TTS and the bulk selection bar. An extension asks
 * the host to run them (bridge calls) or to open the host's own panel for a
 * cell, and renders the results itself — the frame never gets a network,
 * a key, a media stream or an app DOM node.
 */

export type ToolLens = "text" | "audio" | "agent"
export type ToolDirection = "ltr" | "rtl"
export type ToolFootnoteMode = "inline" | "tray" | "off"

export interface ToolLane {
  /** Lane tag the bridge's `lane` option takes ("" = the default target lane). */
  tag: string
  label: string
  code: string | null
}

/** What the host's own editor would show for this file (apiRev 3). */
export interface ToolEditorConfig {
  fileId: string
  fileName: string
  /** Source/target language labels (header chips). */
  sourceLabel: string
  targetLabel: string
  lanes: ToolLane[]
  activeLane: string
  /** Validations a cell needs to count as validated (N of M). */
  validationRequirement: number
  /** The current user may edit translations here (role, scope, project state). */
  canEdit: boolean
  /** The current user may validate here. */
  canValidate: boolean
  /** A commit by this user auto-validates their own edit (project rule). */
  autoValidatesOwnEdits: boolean
  sourceFontSize: number
  targetFontSize: number
  sourceDirection: ToolDirection
  targetDirection: ToolDirection
  lineNumbers: boolean
  cellLabels: boolean
  /** AI drafting is configured (model chosen) and available (credits, online). */
  ai: { configured: boolean; available: boolean }
  backtranslation: { configured: boolean }
  /** Health/rules computation is on for this project. */
  health: boolean
  footnotes: ToolFootnoteMode
  lens: ToolLens
  /** Lenses the host offers for this file. */
  lenses: ToolLens[]
  /** Maintainers may add lanes (the lane switcher's "Add lane…"). */
  canManageLanes: boolean
  /** The host can open these panels for a cell (history.open, …). */
  panels: ToolPanelKind[]
}

export type ToolPanelKind = "history" | "comments" | "attachments" | "rule" | "term" | "recorder"

/** One chapter/section of a file (the built-in editor pages by these). */
export interface ToolSection {
  key: string
  /** "chapter" | "chapter-range" | "preface" | "story" | "time-range" | … */
  kind: string
  /** "Verses 1–45", "Frames 1–8", "50 cells". */
  description: string
  /** "Mark 1" */
  label: string
  /** "1" */
  shortLabel: string
  firstCellId: string
  cellIds: string[]
  translated: number
  validated: number
  total: number
  /** Long sections split into ≤50-cell subsections ("Verses 1–45"). */
  subsections: { key: string; label: string; firstCellId: string; cellIds: string[] }[]
}

export type ToolIssueSeverity = "error" | "warning" | "info"

export interface ToolCellIssue {
  ruleId: string
  /** The rule's name ("Use approved key terms"). */
  ruleName: string
  /** Localized, human-readable reason. */
  message: string
  severity: ToolIssueSeverity
  /** Triggering spans in the plain text of either side, when the rule names them. */
  spans: { side: "source" | "target"; start: number; end: number }[]
  /** Waived by someone (still listed, shown muted). */
  waived: boolean
}

export interface ToolAiState {
  /** "searching" (finding examples) | "generating" | null when idle. */
  phase: "searching" | "generating" | null
  /** Streaming preview text while generating. */
  preview: string | null
  error: string | null
}

/** Per-cell signals the host computes (apiRev 3, `cells.signals`). Maps only
 *  carry cells that have something to say. */
export interface ToolCellSignals {
  /** Source changed since the translation was made (this project / upstream). */
  stale: string[]
  upstreamStale: string[]
  assignments: Record<string, { username: string; scopeLabel: string }>
  /** Repeated source segments in this file: cellId → occurrences. */
  repetition: Record<string, number>
  issues: Record<string, ToolCellIssue[]>
  /** Health point 0–100 per cell (null = not yet computed). */
  health: Record<string, { point: number | null; major: boolean; issue: boolean }>
  ai: Record<string, ToolAiState>
  backtranslating: string[]
  /** Cells someone else changed while this user had them open. */
  remoteChanged: string[]
}

export interface ToolBacktranslation {
  cellId: string
  text: string
  /** The translation changed since this reading was made. */
  stale: boolean
  polished: boolean
  author: string | null
  error: string | null
}

export interface ToolTermMatch {
  side: "source" | "target"
  start: number
  end: number
  term: string
  conceptId: string
  /** Approved renderings, for the hover card. */
  renderings: string[]
  /** For target matches: the rendering is forbidden. */
  forbidden?: boolean
}

export interface ToolPresencePeer {
  username: string
  /** Hex colour the app uses for this collaborator. */
  color: string
  cellId: string | null
  editing: boolean
  /** Their uncommitted text, while typing (ephemeral, never stored). */
  draftText: string | null
  caret: { anchor: number; head: number } | null
}

export interface ToolSuggestion {
  id: string
  /** Text to insert at the caret (ghost text). */
  text: string
  /** Where it came from ("forecast", "memory", …). */
  source: string
}

/** "Where should I work next?" — passage ranges surveyed Bibles break at,
 *  from where the translator left off (the built-in's Suggested passages). */
export interface ToolPericope {
  key: string
  /** "Mark 1:9–1:13" (localized by the host). */
  label: string
  /** "12 of 20 Bibles break here" / "Finishes the passage you are in". */
  detail: string
  /** The first cell of the range in this file. */
  cellId: string
}

/** Cell fields added to the cell view in apiRev 3. */
export interface ToolCellViewRev3 {
  /** Rules waived on this cell (issues for these show muted). */
  waivedRuleIds?: string[]
  /** Validators currently counting on the live translation. */
  validators?: string[]
  /** "none" | "self" | "others" | "full-self" | "full-others" */
  validationStatus?: string
  paragraphStart?: boolean
  /** Cell label (character, IDML slot name, …) and context line. */
  label?: string | null
  context?: string | null
  /** Footnotes extracted from source/target (`\f … \f*` / data-usfm-footnote). */
  footnotes?: { source: { caller: string; text: string }[]; target: { caller: string; text: string }[] }
  hasAudio?: boolean
  attachmentCount?: number
  hidden?: boolean
  /** IDML slot names when the cell is an IDML frame (edit inside slots only). */
  idmlSlots?: string[] | null
  /** The health ribbon beside the target, as the host computes it (smoothed
   *  over neighbours): a CSS background for a 2px line, plus a label. */
  ribbon?: ToolRibbon | null
  /** The gutter number exactly as the built-in shows it ("1", "12a"; null =
   *  structural rows and line numbers off). */
  numberLabel?: string | null
  /** On a paragraph's first cell: how many cells the paragraph has and how
   *  many are still draftable (drives "Draft paragraph"). */
  paragraph?: { size: number; draftable: number } | null
  /** The voice this line speaks in (Audio lens): name, and whether someone
   *  chose it (else the project default). */
  voice?: { name: string; explicit: boolean } | null
}

export interface ToolRibbon {
  stage: "untranslated" | "automatic" | "validated"
  /** CSS background-image for the 2px ribbon line. */
  background: string
  /** Rounded score 0–100 when known. */
  score: number | null
  label: string
}
