/** Sidebar folder labels are short names, not free-form notes. */
export const CORPUS_MARKER_MAX_LEN = 128

/**
 * Accept a corpus marker for persistence. Empty / whitespace / over-long
 * values are dropped so a bad import field cannot poison files.meta.
 */
export function usableCorpusMarker(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > CORPUS_MARKER_MAX_LEN) return undefined
  return trimmed
}

/**
 * Edition folder for a Biblica import whose file.create predates
 * files.meta.corpusMarker. Matches the profile ids stamped as parserVersion
 * (`builtin:biblica-treasure-hunt@1`, …).
 */
const BIBLICA_PROFILE_FOLDERS: Readonly<Record<string, string>> = {
  'builtin:biblica-study-notes': 'Biblica Study Notes',
  'builtin:biblica-treasure-hunt': 'Treasure Hunt Bible',
  'builtin:biblica-reach4life': 'Reach 4 Life',
  'builtin:biblica-ebl': 'Equipping Biblical Leaders',
}

export function corpusMarkerFromParserVersion(parserVersion: unknown): string | undefined {
  if (typeof parserVersion !== 'string') return undefined
  const profileId = parserVersion.split('@')[0]
  return BIBLICA_PROFILE_FOLDERS[profileId]
}

/**
 * Resolve the sidebar folder for a files.meta blob. Explicit corpusMarker
 * wins; otherwise recover Biblica edition folders from parserVersion so
 * imports that landed before the field was persisted still group.
 */
export function resolveCorpusMarker(meta: {
  corpusMarker?: unknown
  parserVersion?: unknown
}): string | undefined {
  return usableCorpusMarker(meta.corpusMarker) ?? corpusMarkerFromParserVersion(meta.parserVersion)
}
