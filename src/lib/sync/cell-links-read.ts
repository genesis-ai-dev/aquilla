// Typed fetch wrapper for the per-file cue-link read, plus the small graph
// type the UI actually works in. (AQU-646 stage 4)
//
// The route returns every live edge TOUCHING the file, from either side, so a
// single read of the subtitle file answers both directions. `buildCueLinkIndex`
// is what turns that flat list into the two lookups every caller wants:
// "which cues perform this subtitle line?" and "which lines does this cue
// perform?".

import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface CueLink {
  kind: string
  /** The subtitle side. */
  fromFileId: string
  fromCellId: string
  /** The audio cue side. */
  toFileId: string
  toCellId: string
  origin: string
  confidence: number | null
}

/** A pair a person has said is NOT a pair. Manual tombstones only — the review
 *  list uses these to stop proposing something already dismissed. */
export interface CueLinkRejection {
  fromCellId: string
  toCellId: string
}

export interface CellLinksResponse {
  links: CueLink[]
  rejected?: CueLinkRejection[]
}

export async function fetchFileCellLinks(
  projectId: string,
  fileId: string,
  jwt: string,
): Promise<CellLinksResponse> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/` +
    `${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/cell-links`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`cell-links failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as CellLinksResponse
}

/**
 * Both directions of the edge set, by cell id.
 *
 * Cell ids are unique across files here — subtitle cells and cue cells are
 * minted as UUIDv7 in different files — so one map per direction is enough and
 * no caller has to carry a file id around to do a lookup.
 */
export interface CueLinkIndex {
  /** subtitle cell id → the audio cues that perform it, in no order. */
  cuesForText: ReadonlyMap<string, readonly string[]>
  /** audio cue id → the subtitle cells it performs. */
  textForCue: ReadonlyMap<string, readonly string[]>
}

export const EMPTY_CUE_LINK_INDEX: CueLinkIndex = {
  cuesForText: new Map(),
  textForCue: new Map(),
}

export function buildCueLinkIndex(links: readonly CueLink[]): CueLinkIndex {
  const cuesForText = new Map<string, string[]>()
  const textForCue = new Map<string, string[]>()
  for (const l of links) {
    const cues = cuesForText.get(l.fromCellId)
    if (cues) cues.push(l.toCellId)
    else cuesForText.set(l.fromCellId, [l.toCellId])
    const texts = textForCue.get(l.toCellId)
    if (texts) texts.push(l.fromCellId)
    else textForCue.set(l.toCellId, [l.fromCellId])
  }
  return { cuesForText, textForCue }
}
