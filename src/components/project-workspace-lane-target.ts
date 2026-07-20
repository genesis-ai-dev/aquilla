// AQU-602: resolve the editor's active target language from the active lane.
//
// The lanes model (AQU-538) is "one source, N target lanes"; a non-default
// lane's tag IS its target language (e.g. lane `'es'` translates into Spanish),
// while the default lane (`''`) uses the project's `targetLanguage`. Switching
// lanes must therefore switch the target language the editor
// reads/writes/translates into — not just the cell filter.
//
// AQU-583: the default lane is driven SOLELY by the PROJECT target, never by a
// per-file one. A file's `targetLanguage` is only ever an import-time snapshot
// (or an inference seed — AQU-249); there is no UI to set a deliberate per-file
// target on the default lane. Consulting it caused two bugs: a stamped value
// shadowed a later Settings change (the pill stayed stale with >1 import), and a
// stamped value (e.g. "English") surfaced when the project had NO target set,
// hiding the "Set target language" prompt. So the project target is the single
// source of truth: when it is unset the default lane has no target (the prompt
// shows), regardless of how many files were imported or what they carry.
// `fileTargetLanguage` is retained in the signature but intentionally unused.
//
// This pure helper isolates that rule from the heavyweight ProjectWorkspace
// component so it can be unit-tested without a harness, mirroring
// `project-workspace-lane-deeplink.ts`.

/**
 * The target language for the currently active lane.
 *
 * - A non-default lane (`activeLane` truthy) → the lane tag itself; a lane's
 *   tag is its target language.
 * - The default lane (`''`) → the project's `targetLanguage` only (AQU-583);
 *   the per-file target is ignored so the project setting is authoritative.
 *
 * Returns `undefined` when the default lane is active and the project carries no
 * target language — the caller then shows the "Set target language" prompt.
 */
export function resolveActiveTargetLanguage(
  activeLane: string,
  // Retained for signature stability; the default lane no longer consults it.
  _fileTargetLanguage: string | null | undefined,
  projectTargetLanguage: string | null | undefined,
): string | undefined {
  if (activeLane) return activeLane
  return projectTargetLanguage || undefined
}
