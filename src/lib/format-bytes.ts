/**
 * Byte-size formatting helpers for import/download progress UIs (AQU-520).
 *
 * The import progress indicators used to show only a percentage / item count,
 * which "feels stalled" on large partner imports (eBible corpora, DCS bundles).
 * These helpers render a transferred/total megabyte readout instead, so the
 * user can see real movement.
 *
 * Locale-aware (WS-09): both functions take an optional `locale`, defaulting
 * to the base `en` catalog locale so untranslated call sites keep compiling.
 * They re-export the implementations in `@/lib/i18n/format` — see that
 * module's doc comment on `formatMB` for why the unit stays `MB` (an
 * SI-derived, language-invariant symbol) while the number in front of it is
 * localized.
 */

export { formatMB, formatBytesProgress } from "./i18n/format"
