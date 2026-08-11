/**
 * Leaf types for per-namespace catalog modules (AQU-511 fan-out).
 *
 * This module imports nothing from the i18n barrels on purpose. `context.ts`
 * and `messages/en.ts` are built FROM the namespace modules, so a namespace
 * module that imported its types from them would close an import cycle.
 *
 * `ContextEntry.screenshot` is `string` rather than `ScreenshotId` for the same
 * reason — the id union is derived from every namespace's surfaces. Undeclared
 * ids are still rejected at test time by `catalogContextIssues()`.
 */

export interface ContextEntry {
  /**
   * What the string does: element type (button / label / toast / tooltip /
   * heading), the action it triggers, and any wording constraint. Written for
   * someone who cannot see the code.
   */
  description: string
  /** Surface screenshot this string appears in; see `screenshots.ts`. */
  screenshot?: string
  /**
   * Soft ceiling in characters, where the layout genuinely constrains the
   * translation (narrow nav column, button in a row of buttons). Omit when the
   * string has room to grow.
   */
  maxLength?: number
  /**
   * Semantics of each `{placeholder}` in the string, keyed by placeholder name
   * without braces. Required for every placeholder the English string uses —
   * `catalogContextIssues()` enforces both directions.
   */
  placeholders?: Record<string, string>
}

export interface ScreenshotSurface {
  /** Stable id; also the PNG basename. Kebab-case, no locale suffix. */
  id: string
  /** Human title shown to translators alongside the image. */
  title: string
  /**
   * Route the capture driver navigates to, in the seeded E2E project.
   * `:projectId` is substituted with the seeded project's id at capture time.
   */
  route: string
  /** What a translator should look for in this shot. */
  notes: string
}

/**
 * One namespace's contribution to the catalog: its English strings, its context
 * block, and the surfaces its context references. `context.keys` is typed
 * against this namespace's own keys, so an entry for another namespace's key is
 * a compile error rather than a lint failure.
 */
export interface NamespaceModule<K extends string> {
  keys: Record<K, string>
  context: {
    _context: ContextEntry
    keys?: Partial<Record<K, ContextEntry>>
  }
  surfaces: readonly ScreenshotSurface[]
}

/** Identity helper that pins `K` to the literal keys of `keys`. */
export function defineNamespace<K extends string>(mod: NamespaceModule<K>): NamespaceModule<K> {
  return mod
}
