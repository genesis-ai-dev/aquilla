// The adapter project's CURRENT source cells — the baseline every DCS delta is
// classified against (`delta.ts` classifyAgainstCurrent).
//
// Extracted from DcsUpstreamPanel (AQU-1860) so the fan-out is unit-testable:
// the baseline used to be built with a sequential `for (const file of files)`
// loop, so a 66-book project paid 66 serial round trips (each itself paginated)
// before any delta work could start. Latency, not work, dominates — so the
// per-file reads run over a small pool instead.

import { mapWithConcurrency } from "@/lib/concurrency"
import { fetchProjectFiles, fetchAllFileCells } from "@/lib/sync/cells-read"
import { contentHash } from "./content-hash"
import type { CurrentCell } from "./delta"

/** Per-file cell reads in flight at once. Enough to hide the round-trip
 *  latency of a full-Bible project without stampeding sync-worker; mirrors the
 *  cap the targeted-read batcher and the export builder already use. */
export const DCS_CELL_READ_CONCURRENCY = 4

/** Any fileId mints a project-scoped token — the token's project claim, not the
 *  fileId, is what authorizes these reads. */
const LIST_FILE_SENTINEL = "__dcs_list__"

export interface BuildCurrentCellsArgs {
  projectId: string
  /** Mints a sync-token scoped to (projectId, fileId). */
  getToken: (fileId: string) => Promise<string | null>
  /** Thrown verbatim when no token can be minted — the caller owns the copy,
   *  so its translated string is threaded in rather than resolved here. */
  tokenErrorMessage: string
}

/**
 * Build the adapter project's current SOURCE cells keyed by cellId. Reads every
 * file's source rows and hashes each cell's plain value with the shared djb2
 * (`./content-hash`) so no-op suppression matches the server and the delta
 * engine.
 *
 * `mapWithConcurrency` returns results in input order and the fold below runs
 * sequentially over them, so the resulting map is byte-identical to what the
 * old serial loop produced — including which file wins if two files were ever
 * to report the same cellId.
 */
export async function buildCurrentCells(
  args: BuildCurrentCellsArgs,
): Promise<Map<string, CurrentCell>> {
  const { projectId, getToken } = args
  const listToken = await getToken(LIST_FILE_SENTINEL)
  if (!listToken) throw new Error(args.tokenErrorMessage)

  const files = await fetchProjectFiles(projectId, listToken)
  const perFile = await mapWithConcurrency(
    files,
    DCS_CELL_READ_CONCURRENCY,
    async (file) => {
      const fileToken = (await getToken(file.fileId)) ?? listToken
      const rows = await fetchAllFileCells(projectId, file.fileId, fileToken, "source")
      return { fileId: file.fileId, rows }
    },
  )

  const out = new Map<string, CurrentCell>()
  for (const { fileId, rows } of perFile) {
    for (const row of rows) {
      out.set(row.cellId, {
        eventId: row.eventId,
        contentHash: contentHash(row.value),
        fileId,
      })
    }
  }
  return out
}
