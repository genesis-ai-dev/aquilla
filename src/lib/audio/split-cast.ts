// AQU-2101: a quote split keeps the original row's id and mints new ids for the
// later pieces. Voice assignments are stored by cell id, so the new narration
// pieces would otherwise fall through to each lane's default. Copy the voice
// the original row already had — on the project-wide map, and on every lane
// map that had cast that row. A row cast only by its character (AQU-2125) has
// no entry of its own; that map's `character:<name>` entry is what gets copied,
// and only when the caller says which character the row names. Quotation
// pieces are not in `sameKindAsFirst`; they stay uncast on purpose.

export interface SplitCastSource {
  cellId: string
  /** New pieces of the same kind as the first piece, in order. */
  sameKindAsFirst: readonly string[]
  /**
   * The character the original row names. Used only when this map has no entry
   * for the row itself. The server reads it off the source cell; it is not a
   * voice id the caller gets to choose.
   */
  castName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function stringEntries(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

/**
 * What this one map already says about the row: its own entry, including the
 * empty string, or else its character's entry. On a lane that empty string is
 * "use my default", and leaving it off the new piece would let a project-wide
 * voice inherit into the gap. A key that is absent is "nothing said yet".
 */
function voiceOnThisMap(map: Record<string, string>, split: SplitCastSource): string | undefined {
  if (split.cellId in map) return map[split.cellId]
  const name = split.castName?.trim()
  if (!name) return undefined
  // Same key `characterCastKey` writes. Inlined so this file stays importable
  // from the auth worker, which does not compile the voice library.
  const key = `character:${name}`
  if (!(key in map)) return undefined
  return map[key]
}

function copyVoice(map: Record<string, string>, splits: readonly SplitCastSource[]): boolean {
  let changed = false
  for (const split of splits) {
    const voiceId = voiceOnThisMap(map, split)
    if (voiceId === undefined) continue
    for (const cellId of split.sameKindAsFirst) {
      if (!cellId || cellId in map) continue
      map[cellId] = voiceId
      changed = true
    }
  }
  return changed
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== "string" || value === "") return null
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The character named on a source cell, or nothing. Metadata may be the
 *  stored object or the JSON string a driver hands back. */
export function castNameFromCellMetadata(metadata: unknown): string | undefined {
  const record = metadataRecord(metadata)
  const raw = record?.cast_name
  if (typeof raw !== "string") return undefined
  const name = raw.trim()
  return name === "" ? undefined : name
}

/**
 * The new piece was cut off `parentCellId`. A user-added line that was not
 * split from that row does not qualify, and neither does a piece split from
 * a different row. The marker is the one `splitLineOrigin` writes.
 */
export function splitPieceBelongsTo(metadata: unknown, parentCellId: string): boolean {
  const record = metadataRecord(metadata)
  const origin = metadataRecord(record?.aquillaOrigin)
  if (!origin || !parentCellId) return false
  return origin.kind === "user-insert" && origin.splitFrom === parentCellId
}

/**
 * The whole tts blob with cast maps updated, or null when no lane and no
 * project-wide cast had a voice to copy. A lane's voice is written only into
 * that lane's map.
 */
export function copyCastsOntoSplitPieces(
  tts: Record<string, unknown> | null | undefined,
  splits: readonly SplitCastSource[],
): Record<string, unknown> | null {
  if (!tts || splits.length === 0) return null
  const next: Record<string, unknown> = { ...tts }
  let changed = false

  const project = stringEntries(tts.castAssignments)
  if (project) {
    const copied = { ...project }
    if (copyVoice(copied, splits)) {
      next.castAssignments = copied
      changed = true
    }
  }

  if (isRecord(tts.laneCastAssignments)) {
    const lanes: Record<string, unknown> = { ...tts.laneCastAssignments }
    let lanesChanged = false
    for (const [tag, value] of Object.entries(tts.laneCastAssignments)) {
      const cells = stringEntries(value)
      if (!cells) continue
      const copied = { ...cells }
      if (!copyVoice(copied, splits)) continue
      lanes[tag] = copied
      lanesChanged = true
    }
    if (lanesChanged) {
      next.laneCastAssignments = lanes
      changed = true
    }
  }

  return changed ? next : null
}
