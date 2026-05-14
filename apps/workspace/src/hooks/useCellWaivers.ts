// Phase 2b: cell waivers dropped from v1 event grammar (see 03-data-model.md);
// stubbed. Future v1.x feature.
//
// Pre-Phase 2b waivers lived on the cell's Y.Map as a `waivers` array,
// resyncing via the file's Y.Doc room. The v1 event grammar does not include
// `cell.waiver.*` kinds; rather than ship a half-server / half-client
// surface, we stub the read+write helpers. Existing call sites still
// compile; setCellWaivers silently no-ops and readCellWaivers always
// returns an empty array. Tests assert the stub behavior.

import type { RuleWaiver } from "@/lib/parsers/types"

/**
 * Stub: always returns an empty array. Phase 2c will introduce a server-
 * authoritative read path bound to the event log.
 */
export function readCellWaivers(_doc: unknown, _cellId: string): RuleWaiver[] {
  return []
}

/**
 * Stub: no-op. Phase 2c will emit a `cell.waiver.*` event via the outbox.
 */
export function setCellWaivers(
  _doc: unknown,
  _cellId: string,
  _waivers: RuleWaiver[],
): void {
  /* phase 2b: waivers stubbed; no-op until v1.x event grammar lands */
}
