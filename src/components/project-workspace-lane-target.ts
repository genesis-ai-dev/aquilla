// AQU-602: resolve the editor's active target language from the active lane.
//
// The lanes model (AQU-538) is "one source, N target lanes"; a non-default
// lane's tag IS its target language (e.g. lane `'es'` translates into Spanish),
// while the default lane (`''`) uses the project's `targetLanguage`, falling
// back to the file's. Switching lanes must therefore switch the target language
// the editor reads/writes/translates into — not just the cell filter.
//
// AQU-583: the default lane prefers the PROJECT target over the per-file one.
// A file's `targetLanguage` is only ever an import-time snapshot of whatever the
// project default was then (or an inference seed — AQU-249); there is no UI to
// set a deliberate per-file target on the default lane. When a maintainer later
// changes the project's target language in Settings, that new value must win
// everywhere on the default lane — otherwise files stamped at import keep
// shadowing it and the pill/translation stay stale. The file value survives only
// as a fallback for when the project has no target set yet (AQU-249).
//
// This pure helper isolates that rule from the heavyweight ProjectWorkspace
// component so it can be unit-tested without a harness, mirroring
// `project-workspace-lane-deeplink.ts`.

/**
 * The target language for the currently active lane.
 *
 * - A non-default lane (`activeLane` truthy) → the lane tag itself; a lane's
 *   tag is its target language.
 * - The default lane (`''`) → the project's `targetLanguage`, then the file's
 *   (AQU-583: the project default wins so a Settings change is reflected even
 *   when files carry an import-time per-file target; the file value is only a
 *   fallback for a project with no target set yet — AQU-249).
 *
 * Returns `undefined` when the default lane is active and neither the project
 * nor the file carries a target language.
 */
export function resolveActiveTargetLanguage(
  activeLane: string,
  fileTargetLanguage: string | null | undefined,
  projectTargetLanguage: string | null | undefined,
): string | undefined {
  if (activeLane) return activeLane
  return projectTargetLanguage || fileTargetLanguage || undefined
}
