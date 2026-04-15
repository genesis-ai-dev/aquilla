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
  originalText?: string;
  globalReferences?: string[];
}

export interface CodexCellMetadata {
  id: string;
  type: CodexCellType;
  edits?: EditHistory[];
  data?: CodexData;
  cellLabel?: string;
  parentId?: string;
  isLocked?: boolean;
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
  textDirection?: "ltr" | "rtl";
  videoUrl?: string;
  sourceCreatedAt?: string;
  codexLastModified?: string;
  navigation?: unknown[];
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
export interface CodexProjectMetadata {
  projectName?: string;
  sourceLanguage?: { tag: string; refName?: string };
  targetLanguage?: { tag: string; refName?: string };
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}
