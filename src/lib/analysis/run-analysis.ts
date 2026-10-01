// AQU-1392: the runner that walks a project's files and produces the report.
//
// Why this is not just `files.map(analyzeFile)`:
//
//   * A whole-Bible project is ~31k segments across 66 files. Banding is
//     O(n·w) per file, so the arithmetic is fine — what is not fine is doing
//     all of it inside one task. The loop therefore hands the event loop back
//     between files (`yieldToUi`), which is what keeps "Analyze on a project"
//     from freezing the tab (AC 2). The work is chunked at the file boundary
//     because that is also the unit banding is defined over — no partial file
//     is ever banded, so a yield can never change a number.
//   * Loading is injected (`loadSources`) rather than imported, so the same
//     runner is exercised by unit tests with an in-memory fetcher and by the
//     UI with `fetchAllFileCells(side: "source")`. It also lets the UI swap in
//     already-loaded cells for the file the editor has open instead of
//     re-fetching them.
//   * A file that fails to load does not sink the run: it lands in `skipped`
//     and the report says so, because a PM would rather have 65 books and a
//     named gap than an error page.
//
// Cancellation is an `AbortSignal` so the dialog can be closed mid-run without
// leaving an orphaned loop mutating state.

import { analyzeFile, buildAnalysisReport, type AnalysisReport, type FileAnalysis } from "./report"

export interface AnalyzableFile {
  fileId: string
  name: string
}

export interface RunAnalysisProgress {
  /** Files finished so far (including skipped ones). */
  done: number
  total: number
  /** Name of the file just finished, for the progress line. */
  current: string
}

export interface RunAnalysisOptions {
  files: readonly AnalyzableFile[]
  /** Fetch one file's source segments, in file order. */
  loadSources: (file: AnalyzableFile) => Promise<readonly string[]>
  scope: "file" | "project"
  label: string
  onProgress?: (progress: RunAnalysisProgress) => void
  signal?: AbortSignal
  fuzzyWindow?: number
  /** Seam for tests; defaults to a macrotask yield. */
  yieldToUi?: () => Promise<void>
}

export interface RunAnalysisResult {
  report: AnalysisReport
  /** Files whose source could not be read, with the reason. */
  skipped: { fileId: string; name: string; reason: string }[]
  /** True when the run was aborted before every file was banded. */
  aborted: boolean
}

/** Default yield: a macrotask, so paint and input get a turn between files. */
const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runAnalysis(opts: RunAnalysisOptions): Promise<RunAnalysisResult> {
  const yieldToUi = opts.yieldToUi ?? defaultYield
  const analyses: FileAnalysis[] = []
  const skipped: RunAnalysisResult["skipped"] = []
  let aborted = false
  let done = 0

  for (const file of opts.files) {
    if (opts.signal?.aborted) {
      aborted = true
      break
    }
    try {
      const sources = await opts.loadSources(file)
      // Re-check after the await: the dialog may have closed while it was in
      // flight, and banding a file nobody will see is wasted main-thread time.
      if (opts.signal?.aborted) {
        aborted = true
        break
      }
      analyses.push(analyzeFile({ fileId: file.fileId, name: file.name, sources }, opts.fuzzyWindow))
    } catch (err) {
      skipped.push({ fileId: file.fileId, name: file.name, reason: reasonOf(err) })
    }
    done += 1
    opts.onProgress?.({ done, total: opts.files.length, current: file.name })
    // Yield between files, never inside one — see the note at the top.
    if (done < opts.files.length) await yieldToUi()
  }

  return {
    report: buildAnalysisReport(analyses, { scope: opts.scope, label: opts.label }),
    skipped,
    aborted,
  }
}
