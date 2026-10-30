export const CORPUS_DIR: string
export const R2_BUCKET: string
export const R2_PREFIX: string
export const INPUT_TABLES: string[]

export type CorpusRows = Record<string, Array<Record<string, unknown>>>

export interface CorpusEntry {
  slug: string
  source: "synthetic" | "r2"
  file: string
  sha256: string
  events: number
  maxSeq: number
  capturedAt: string
}

export interface CorpusManifest {
  format: 1
  projects: CorpusEntry[]
}

export function sha256Hex(bytes: string | Buffer): string
export function serializeRow(row: Record<string, unknown>): Record<string, unknown>
export function corpusBytes(rows: CorpusRows): string
export function manifestEntry(input: {
  slug: string
  source: "synthetic" | "r2"
  file: string
  bytes: string
  events: Array<Record<string, unknown>>
  capturedAt: string
}): CorpusEntry
export function upsertEntry(manifest: CorpusManifest, entry: CorpusEntry): CorpusManifest
export function readManifest(dir?: string): CorpusManifest
export function writeManifest(manifest: CorpusManifest, dir?: string): void
export function buildSyntheticCorpus(): { projectId: string; rows: CorpusRows }
export function exportProject(
  sql: { unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> },
  projectId: string,
): Promise<CorpusRows>
