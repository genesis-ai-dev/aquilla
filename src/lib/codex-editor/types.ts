// Mirrored from /Users/ryderwishart/frontierrnd/codex-editor/types/index.d.ts
// Kept minimal to what Phase 1 parses.

export type CodexCellKind = 1 | 2;

export const CodexCellTypes = {
  TEXT: "text",
  PARATEXT: "paratext",
  STYLE: "style",
  MILESTONE: "milestone",
} as const;
export type CodexCellType = typeof CodexCellTypes[keyof typeof CodexCellTypes];

export const EditType = {
  USER_EDIT: "user-edit",
  LLM_EDIT: "llm-edit",
  LLM_GENERATION: "llm-generation",
  INITIAL_IMPORT: "initial-import",
  MERGE: "merge",
  MIGRATION: "migration",
} as const;
export type EditTypeValue = typeof EditType[keyof typeof EditType];

export interface ValidationEntry {
  username: string;
  creationTimestamp: number;
  updatedTimestamp: number;
  isDeleted: boolean;
}

export interface EditHistory {
  author: string;
  timestamp: number;
  type: EditTypeValue;
  editMap: string[];
  value: unknown;
  validatedBy?: ValidationEntry[];
}

export interface CodexData {
  startTime?: number;
  endTime?: number;
  book?: string;
  chapter?: string;
  verse?: string;
  deleted?: boolean;
  /** Codex cell-merge marker: the cell's content was absorbed into another
   *  cell (heading consolidation, verse-range merge) and Codex hides it. */
  merged?: boolean;
  /** Codex Source Editing Mode eye icon: the cell is PARKED — dropped from the
   *  normal view, progress and every exporter, but its data is kept and an
   *  unhide brings it back. Written on both the `.source` and the paired
   *  `.codex` cell; unhide writes `false` rather than removing the key
   *  (AQU-1425). Reversible, so unlike `deleted`/`merged` it must NOT migrate
   *  as a retraction. */
  hidden?: boolean;
  originalText?: string;
  globalReferences?: string[];
  /**
   * Legacy Codex IDML surgical-export metadata. Keep this deliberately open:
   * several desktop releases added fields without bumping the notebook
   * schema. The shared v2 upgrader validates the exact supported shape.
   */
  idmlStructure?: Record<string, unknown>;
  /** Legacy multipart relationships used to prove an IDML cell's stable part. */
  relationships?: Record<string, unknown>;
}

export interface CodexCellAttachment {
  url: string;
  type: string;
  createdAt?: number;
  updatedAt?: number;
  isDeleted?: boolean;
  isMissing?: boolean;
  /**
   * Which slot of the cell this clip occupies — "recording", "generatedVoice",
   * or (AQU-646) an extra target track's id.
   *
   * Carried so a consumer can READ the slot instead of inferring it from which
   * of the cell's selection pointers happens to equal this clip's id. That
   * inference is only ever able to tell apart the slots that existed when it
   * was written, and a re-attach naming the wrong slot MOVES the clip and
   * deselects whatever was in the slot it lands in.
   *
   * Optional because a hand-built cell stub (the recording modal's, notably)
   * has no server row to copy it from. A caller that might be looking at a stub
   * must be told the slot explicitly rather than reading it here.
   */
  slot?: string;
  /** Voice metadata, carried so a trim re-attach preserves it (doesn't null it). */
  voiceId?: string;
  referenceAudioId?: string;
  durationMs?: number;
  /** AQU-646: non-destructive playback trim window into the clip, in ms.
   *  Imported media segments share one clip; the trim identifies this cell's
   *  slice (transcription must decode only this window, not the whole file). */
  trimStartMs?: number;
  trimEndMs?: number;
  /**
   * AQU-646 stage 3: where this take sits against its line, in ms from the
   * line's own start. Undefined means "never placed by hand" — NOT zero, which
   * is a real placement — so readers fall back to the cell's own
   * `target_offset_ms` for every take that predates it.
   */
  targetOffsetMs?: number | null;
  /**
   * AQU-2267: where this take sits FOLLOWING THE RECORDINGS, measured the same
   * way from its line's start in that layout; `targetOffsetMs` is its place
   * following the source. Undefined = no place of its own there, and that
   * timing reads `targetOffsetMs` as it always has (every take before AQU-2267).
   */
  recordingsOffsetMs?: number | null;
  /** SUB-48: this clip's event is still queued locally (saved on this device,
   *  not yet at the server). Drives the "saving…" hint on chips/rows. */
  pendingSync?: true;
  /** AQU-924: this clip's attach event was quarantined / exhausted its retries,
   *  so the server has no attachment for it and won't without user action. The
   *  clip stays visible in this state instead of silently disappearing. */
  syncFailed?: true;
  /**
   * AQU-490: this take's validation state, carried so the gutter, the take
   * block, the recorder's list, the timeline chip and the voice panel all read
   * one answer instead of five.
   *
   * `validatorCount` is what gets compared to the project's threshold;
   * `validators` is the hover list and the "have I validated this?" test.
   * `role` distinguishes a dub from the imported programme audio, which is
   * selected on every cell of a media file and is never counted. `recordedBy`
   * is UNKNOWN when absent and must never be read as a match for the viewer.
   *
   * All optional: a hand-built cell stub has no server row to copy them from,
   * and a worker predating AQU-490 sends none of them.
   */
  validatorCount?: number;
  validators?: string[];
  /**
   * AQU-2296: username → when that person validated this take (server clock,
   * ms) — the date under each name in "Audio validated by". Optional for the
   * same reason the two above are; absent draws the name with no date line.
   */
  validatorDecidedTs?: Record<string, number>;
  role?: "dub" | "source";
  recordedBy?: string | null;
  /** AQU-1767: the take this one was cut from (its piece group's root). */
  pieceOf?: string | null;
  /** Two-step transcription (0186): what ASR heard, kept through corrections. */
  asrText?: string | null;
  asrModel?: string | null;
  /** Provenance of an AI cleanup while the transcript is still the AI's. */
  transcriptAi?: { model: string; at: number; changes: number } | null;
  /** AQU-646 round 8: the take's permanent display name ("Take 3", or a
   *  rename). Carried so the Recording tab can head an added-track take with
   *  its own name rather than its track id. */
  label?: string | null;
  /**
   * AQU-965: this take was withdrawn from the export in flight, for want of
   * validation. Set only on the COPIES an export's scoping step makes
   * (`scopeAudioCellsForExport`) and never on a stored attachment or on
   * anything a read path produces, so no surface outside an export in progress
   * ever sees it.
   *
   * It marks rather than removes because what withdrawing means differs per
   * deliverable — missing from the per-line zip, silence in place in a mixed
   * or chapter track — and the url, `durationMs` and trim window have to
   * survive for the chapter stitch to size the gap it writes.
   */
  silencedForExport?: true;
}

// Per-word timing for karaoke / forced-alignment / ASR output. Character
// offsets refer to the cell's plain text at the time the timing was produced;
// they may go stale if the cell is edited afterward.
export interface WordTiming {
  word: string;
  t0: number;   // seconds from the start of the audio clip
  t1: number;
  start: number; // inclusive char offset in cell plain text
  end: number;   // exclusive char offset
}

export interface CodexCellMetadata {
  id: string;
  type: CodexCellType;
  /** Legacy IDML story/paragraph identity mirrored from the desktop shape. */
  storyId?: string;
  paragraphId?: string;
  /** Already-upgraded IDML v2 format metadata, when emitted by newer Codex. */
  idml?: Record<string, unknown>;
  /** Normalized import provenance, including the v2 IDML source locator. */
  aquillaImport?: Record<string, unknown>;
  edits?: EditHistory[];
  data?: CodexData;
  cellLabel?: string;
  parentId?: string;
  isLocked?: boolean;
  attachments?: Record<string, CodexCellAttachment>;
  selectedAudioId?: string;
  selectedGeneratedVoiceAudioId?: string;
  audioTimings?: Record<string, WordTiming[]>;
  ttsSettings?: import("@/lib/parsers/types").CellTtsSettings;
}

export interface CodexCell {
  kind: CodexCellKind;
  languageId: string;
  value: string;
  metadata: CodexCellMetadata;
}

export interface CodexNotebookMetadata {
  id: string;
  originalName: string;
  corpusMarker?: string;
  lineNumbersEnabled?: boolean;
  textDirection?: "ltr" | "rtl";
  videoUrl?: string;
  sourceCreatedAt?: string;
  codexLastModified?: string;
  navigation?: unknown[];
  edits?: EditHistory[];    // NEW — file-level edit ledger, same shape as cell edits
  [key: string]: unknown;
}

export interface CodexNotebookFile {
  cells: CodexCell[];
  metadata: CodexNotebookMetadata;
}

// comments.json
export interface CodexComment {
  id: string;
  timestamp: number;
  body: string;
  mode: number;
  deleted: boolean;
  author: { name: string };
}

export interface CodexCellIdGlobalState {
  cellId: string;
  globalReferences?: string[];
  uri?: string;
  fileDisplayName?: string;
  cellLabel?: string;
}

export interface CodexCommentThread {
  id: string;
  cellId: CodexCellIdGlobalState;
  comments: CodexComment[];
  collapsibleState: number;
  canReply: boolean;
  threadTitle?: string;
  deletionEvent?: Array<{ timestamp: number; author: { name: string }; deleted: boolean }>;
  resolvedEvent?: Array<{ timestamp: number; author: { name: string }; resolved: boolean }>;
}

export type CodexCommentsFile = Record<string, CodexCommentThread>;

// Root metadata.json — same shape as CodexNotebookMetadata plus project-level fields.
//
// The desktop codex-editor wrote two different shapes over its history. Newer
// projects flatten the language pair onto the root as `sourceLanguage` /
// `targetLanguage`. Older / Scripture-Burrito-aligned projects use a
// `languages` array where each entry carries a `projectStatus` discriminator
// of "source" or "target". We model both so importers can fall back when the
// flat shape is missing.
export interface CodexLanguageEntry {
  tag: string;
  refName?: string;
  /** "source" | "target" — desktop sometimes uses these strings, sometimes
   *  the LanguageProjectStatus enum value with the same wire format. */
  projectStatus?: string;
  name?: Record<string, string> | string;
  [key: string]: unknown;
}

export interface CodexProjectMetadata {
  projectName?: string;
  sourceLanguage?: { tag: string; refName?: string };
  targetLanguage?: { tag: string; refName?: string };
  /** Legacy/burrito shape — entries discriminated by `projectStatus`. */
  languages?: CodexLanguageEntry[];
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}
