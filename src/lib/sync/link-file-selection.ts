// AQU-1561: the pure folds over an upstream file selection — the numbers both
// the Source & sync link flow and Create New Project read off the checked rows.
//
// Deliberately NOT in `link-source-preview.ts`, which they fold the type of:
// that module is the one that READS the upstream (`loadLinkSourcePreview`,
// `loadUpstreamFileChoices`), so tests stub it wholesale to keep the network out
// of a component test. Logic every one of those components then needs must not
// be stubbed away with it. The type travels as `import type`, which is erased,
// so this module depends on nothing at runtime.

import type { LinkSourcePreviewFile } from "./link-source-preview"

/**
 * AQU-1561: the two numbers every caller needs off a selection, derived in one
 * place so the "all files" default and the nothing-checked refusal mean the same
 * thing in both flows.
 *
 * `allSelected` is what decides whether the request omits `fileIds` entirely
 * (follow the whole project, including files the upstream gains later) or sends
 * the picked ids (a fixed list). `nothingSelected` is the one state both flows
 * refuse — a link or a clone that carries no files is a mistake, not a choice —
 * and is deliberately false for an EMPTY upstream, which is a different and
 * perfectly linkable situation.
 */
export function summarizeFileSelection(
  files: readonly LinkSourcePreviewFile[],
  selectedFileIds: ReadonlySet<string>,
): { selectedCount: number; allSelected: boolean; nothingSelected: boolean } {
  const selectedCount = files.filter((f) => selectedFileIds.has(f.id)).length
  return {
    selectedCount,
    allSelected: files.length > 0 && selectedCount === files.length,
    nothingSelected: files.length > 0 && selectedCount === 0,
  }
}

/** AQU-1561: the clashing names still CHECKED, de-duplicated by name. Unchecking
 *  a clashing file takes it out of the warning, because a file that is not
 *  coming cannot collide with anything. */
export function selectedClashNames(
  files: readonly LinkSourcePreviewFile[],
  selectedFileIds: ReadonlySet<string>,
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (!f.clashes || !selectedFileIds.has(f.id)) continue
    const key = f.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(f.name)
  }
  return names
}
