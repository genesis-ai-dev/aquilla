// Builds the JSON `meta` blob for a `files` row from a file.create payload.
//
// Per 03-data-model.md §"Column vs JSON meta", sparse / schema-evolving
// provenance fields and per-file language overrides live in `files.meta`
// rather than as dedicated columns. Only defined keys are written so the
// blob stays compact and `json_extract` returns NULL for absent ones.

import type { EventPayloads } from './types'

export interface FileMeta {
  r2_key?: string
  blob_sha?: string
  import_format?: string
  parser_version?: string
  source_language?: string
  target_language?: string
}

export function buildFileMeta(p: EventPayloads['file.create']): string {
  const meta: FileMeta = {}
  if (p.r2Key != null) meta.r2_key = p.r2Key
  if (p.blobSha != null) meta.blob_sha = p.blobSha
  if (p.importFormat != null) meta.import_format = p.importFormat
  if (p.parserVersion != null) meta.parser_version = p.parserVersion
  if (p.sourceLanguage != null) meta.source_language = p.sourceLanguage
  if (p.targetLanguage != null) meta.target_language = p.targetLanguage
  return JSON.stringify(meta)
}
