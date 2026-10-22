// Shapes of the LangQuest link API (auth-worker routes/langquest.ts), which
// in turn mirror LangQuest's partner API (its apps/web/worker/agent/view.ts).

export type LangQuestScope = "read:published" | "read" | "review" | "release" | "external_values"

export interface LangQuestCan {
  read: "all" | "published" | null
  review: boolean
  release: boolean
  externalValues: { read: boolean; write: boolean }
}

export interface LangQuestLanguage {
  languageId: string
  name: string
  code: string
  country: string | null
  can: LangQuestCan
}

/** What POST /inspect says about a pasted token. */
export interface LangQuestInspection {
  apiBase: string
  org: { id: string; name: string }
  token: { id: string; name: string; scopes: LangQuestScope[]; expiresAt: string | null; allLanguages: boolean }
  languages: LangQuestLanguage[]
}

export interface LangQuestLink {
  projectId: string
  apiBase: string
  org: { id: string; name: string }
  language: { id: string; name: string; code: string }
  scopes: LangQuestScope[]
  can: LangQuestCan | null
  tokenExpiresAt: string | null
  needsReauth: boolean
  lastSyncedAt: string | null
  lastSyncError: string | null
  linkedBy: string
  linkedAt: string | null
}

export interface LangQuestAudioCard {
  hash: string
  format: "wav" | "m4a"
  durationMs: number
  url: string
  expiresAt: string
}

export interface LangQuestPassage {
  unitId: string
  label: string
  path: string[]
  kind: string
  order: string
  reference: {
    book: string
    chapter: number | null
    verse: number | null
    endChapter: number | null
    endVerse: number | null
  } | null
  status: "not_started" | "drafting" | "in_review" | "feedback" | "approved"
  version: { n: number; takeId: string; submittedAt: string; durationMs: number } | null
  approvedVersion: { n: number; takeId: string } | null
  updatedAt: string | null
  audio?: LangQuestAudioCard[]
}

export interface LangQuestChange {
  cursor: string
  type: string
  unitId: string
  at: string
}

/** One row of the project's passage→cell map. */
export interface KnownPassage {
  unitId: string
  fileId: string
  cellId: string
  label: string
  order: string
  /** The LangQuest version last attached as a take; null when none has audio yet. */
  takeId: string | null
}
