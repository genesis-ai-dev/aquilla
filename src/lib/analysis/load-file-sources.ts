// AQU-1392: the network adapter behind `runAnalysis`'s `loadSources` seam.
//
// Split out of both call sites (the editor's file menu and the project
// dashboard) so the two surfaces read source text exactly the same way, and so
// `run-analysis.ts` itself stays free of network imports and testable in
// isolation.
//
// Reads the SOURCE side only: banding is a property of the source document, and
// fetching target rows would roughly double the bytes for a whole-Bible project
// with nothing to show for it. Source rows are shared by every target lane, so
// no lane filter applies.

import { fetchAllFileCells } from "@/lib/sync/cells-read"
import type { AnalyzableFile } from "./run-analysis"

export type FileTokenFetcher = (fileId: string) => Promise<string | null>

/**
 * Build the `loadSources` function for a project. Returned segments are in
 * anchor-chain (file) order, which is what repetition and internal-fuzzy
 * banding assume: "an EARLIER segment" has to mean earlier in the document.
 */
export function buildSourceLoader(
  projectId: string,
  getTokenForFile: FileTokenFetcher,
): (file: AnalyzableFile) => Promise<readonly string[]> {
  return async (file) => {
    const token = await getTokenForFile(file.fileId)
    // No token means no read access to this file. Throwing puts it in the
    // report's `skipped` list by name, which is more use to a project manager
    // than silently counting it as zero words.
    if (!token) throw new Error(`no access token for file ${file.fileId}`)
    const rows = await fetchAllFileCells(projectId, file.fileId, token, "source")
    return rows.map((r) => r.value)
  }
}
