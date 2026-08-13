// AQU-848: resolve the editor's active SOURCE language.
//
// The project's `sourceLanguage` setting is the single source of truth for what
// the editor labels — and what the AI is told to translate *from*. A file's
// `sourceLanguage` is only ever an import-time snapshot (or an inference seed):
// it is stamped onto `file.create` from whatever the project carried at import,
// and some importers stamp a literal (e.g. the OBS path stamps `"en"`). There is
// no UI to set a deliberate per-file source language.
//
// Consulting that stamp caused the reported bug: a project whose source is set
// to a low-resource language (Gom) kept reporting English in the editor, because
// a file imported while the project still said English shadowed the setting —
// and changing the setting afterwards could never clear it. Worse, this is
// exactly the case the product exists to serve, and the wrong label travelled
// into AI output.
//
// This mirrors the TARGET-side rule settled in AQU-583
// (`project-workspace-lane-target.ts`): the project setting wins, always, so a
// Settings change is reflected without recreating the project or re-importing.
// `fileSourceLanguage` is retained in the signature but intentionally unused, so
// the call site still documents what is deliberately being ignored.
//
// Pure helper, isolated from the heavyweight ProjectWorkspace component so the
// rule can be unit-tested without a harness.

/**
 * The source language the editor should display and translate from.
 *
 * Always the project's configured `sourceLanguage` (AQU-848); the per-file
 * import-time stamp is ignored.
 *
 * Returns `undefined` when the project carries no source language, so the caller
 * falls back to its own "unset" handling rather than surfacing a stamped value.
 */
export function resolveActiveSourceLanguage(
  // Retained for signature stability; deliberately not consulted (AQU-848).
  _fileSourceLanguage: string | null | undefined,
  projectSourceLanguage: string | null | undefined,
): string | undefined {
  return projectSourceLanguage?.trim() || undefined
}
