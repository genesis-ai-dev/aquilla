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
  description: string
  screenshot?: string
  maxLength?: number
  placeholders?: Record<string, string>
}

export interface ScreenshotSurface {
  id: string
  title: string
  route: string
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
