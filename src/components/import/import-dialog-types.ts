/**
 * Shared types for `ImportDialog.tsx` and its extracted per-format panels
 * under `src/components/import/`. Split out of `ImportDialog.tsx` (was
 * 3,618 lines / 14 components) so panels don't import from the dialog
 * itself, which would create a runtime import cycle.
 */

export type Screen =
  | "landing"
  | "upload"
  | "preview"
  | "ebible"
  | "helloao"
  | "obs"
  | "macula"
  | "tn"
  | "biblica"
  | "direction"
  | "result"
  | "collision"
  | "spreadsheet"
  | "labels"
  | "paired"
  | "sdbh"
  | "dcs"
  | "gdrive"

export interface CollisionResolution {
  skipKeys: ReadonlySet<string>
  /** normalized incoming book-code/name → existing file id */
  reimportFileIds: ReadonlyMap<string, string>
}
