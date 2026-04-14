export type FileType = "md" | "docx" | "pptx" | "txt" | "vtt" | "srt" | "usfm"

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
}

export interface FileReference {
  id: string
  name: string
  type: FileType
  createdAt: string
  cellCount: number
}

export interface ProjectMember {
  userId: string
  role: "owner" | "translator" | "reviewer"
}

export interface CompletionSettings {
  endpoint: string
  model: string
  maxTokens: number
  temperature: number
  systemPrompt: string
  llmHealthPenalty: number // 0-1, default 0.1 (10% penalty). Multiplier = 1 - penalty.
}

export interface CellHistoryEntry {
  timestamp: string
  value: string
  source: "human" | "llm"
  author: string
  validated: boolean
  examples?: string[]
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
