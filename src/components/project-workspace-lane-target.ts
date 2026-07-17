// AQU-602: resolve the editor's active target language from the active lane.
//
// The lanes model (AQU-538) is "one source, N target lanes"; a non-default
// lane's tag IS its target language (e.g. lane `'es'` translates into Spanish),
// while the default lane (`''`) uses the file's `targetLanguage`, falling back
// to the project's. Switching lanes must therefore switch the target language
// the editor reads/writes/translates into — not just the cell filter.
//
// This pure helper isolates that rule from the heavyweight ProjectWorkspace
// component so it can be unit-tested without a harness, mirroring
// `project-workspace-lane-deeplink.ts`.

/**
 * The target language for the currently active lane.
 *
 * - A non-default lane (`activeLane` truthy) → the lane tag itself; a lane's
 *   tag is its target language.
 * - The default lane (`''`) → the file's `targetLanguage`, then the project's.
 *
 * Returns `undefined` when the default lane is active and neither the file nor
 * the project carries a target language (same shape as the previous inline
 * `activeFile?.targetLanguage || project?.targetLanguage`).
 */
export function resolveActiveTargetLanguage(
  activeLane: string,
  fileTargetLanguage: string | null | undefined,
  projectTargetLanguage: string | null | undefined,
): string | undefined {
  if (activeLane) return activeLane
  return fileTargetLanguage || projectTargetLanguage || undefined
}
