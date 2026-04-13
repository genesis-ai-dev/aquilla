export type FileType = "md" | "docx" | "pptx" | "txt" | "vtt" | "srt" | "usfm"

export type CellType =
  | "text"
  | "heading"
  | "list"
  | "blockquote"
  | "cue"
  | "verse"
  | "paratext"

export interface TranslatableString {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  type: CellType
}

export interface ProjectRecord {
  id: string
  name: string
  sourceLanguage: string
  targetLanguage: string
  createdAt: string
  files: FileReference[]
  members: ProjectMember[]
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
