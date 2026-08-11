/**
 * Context-rich catalog metadata (AQU-832).
 *
 * The bottleneck in UI localization is never the string count — it's missing
 * context. "Save" translates differently depending on whether it's a button or
 * a menu item, what it saves, and how much room it has. So the catalog carries
 * its own context: every message key resolves to a description of what the
 * string does, the surface it lives on, a screenshot of that surface, and the
 * semantics of any `{placeholder}`.
 *
 * Two levels, so per-key notes stay tiny:
 *   - **namespace `_context`** — describes the surrounding surface once
 *     (`nav` → "top-level workspace navigation"). Covers every key in the
 *     namespace.
 *   - **per-key entry** — only where the namespace note isn't enough (a
 *     placeholder to explain, a length limit, a non-obvious action).
 *
 * A key is *covered* when its namespace has a `_context.description`; per-key
 * entries refine, they don't gate. `catalogContextIssues()` is the lint that
 * enforces coverage plus placeholder agreement, and is run both by
 * `context.test.ts` (so `pnpm test` is the CI gate) and by
 * `scripts/i18n-catalog.ts check`.
 *
 * This module is the authored source of the standard; the JSON interchange
 * sidecar shipped to translators is generated from it verbatim by
 * `catalog-export.ts`. Authoring in TypeScript rather than JSON buys
 * compile-time checking: an entry for a key that doesn't exist, or one filed
 * under the wrong namespace, fails `tsc`.
 *
 * This file is a barrel: each namespace's block is authored in its own module
 * under `namespaces/`, next to that namespace's keys and its screenshot
 * surfaces, and collected here. Screenshot ids are checked by this module's lint
 * and by `context.test.ts` rather than by `tsc` — see `namespaces/types.ts` for
 * why keeping them a compile-time union would reinstate an import cycle.
 *
 * See `docs/I18N-CONTEXT-CATALOG.md` for the standard and the new-key workflow.
 */

import { en, type MessageKey } from "./messages/en"
import { NAMESPACES } from "./namespaces"
import type { ContextEntry } from "./namespaces/types"
import { isScreenshotId, SCREENSHOTS } from "./screenshots"

/** Version of the sidecar interchange format emitted by `catalog-export.ts`. */
export const CONTEXT_SCHEMA_VERSION = 1

/** Minimum useful description length — a one-word note is not context. */
const MIN_DESCRIPTION_LENGTH = 12

/** Re-exported so consumers keep importing the entry shape from here. */
export type { ContextEntry } from "./namespaces/types"

export interface NamespaceBlock {
  /** Surface-level context inherited by every key in the namespace. */
  _context: ContextEntry
  /** Per-key refinements, keyed by the FULL message key (`nav.projects`). */
  keys?: Partial<Record<MessageKey, ContextEntry>>
}

/**
 * The catalog's context sidecar, keyed by namespace — the segment before the
 * first `.` of a message key. Keys inside `keys` are full message keys so that
 * multi-segment keys (`error.generic.title`) stay unambiguous.
 */
export const CATALOG_CONTEXT: Record<string, NamespaceBlock> = Object.fromEntries(
  NAMESPACES.map((ns) => [namespaceOf(Object.keys(ns.keys)[0]), ns.context]),
)

/** Namespace of a message key: everything before the first `.`. */
export function namespaceOf(key: string): string {
  const dot = key.indexOf(".")
  return dot === -1 ? key : key.slice(0, dot)
}

/** Placeholder names (`{name}`) used by a message template, in order, deduped. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>()
  for (const match of template.matchAll(/\{(\w+)\}/g)) found.add(match[1])
  return [...found]
}

/** Fully resolved context for one message key: per-key entry over namespace. */
export interface ResolvedContext {
  key: MessageKey
  namespace: string
  /** The English source string, for reference. */
  source: string
  /** Namespace-level description of the surrounding surface. */
  surface: string
  /** Per-key description when present, otherwise the surface description. */
  description: string
  screenshot?: string
  maxLength?: number
  placeholders: Record<string, string>
}

/**
 * Resolve a key's context by layering its per-key entry over its namespace
 * `_context`. Scalars fall back field by field; `placeholders` merge, with the
 * per-key entry winning on conflict. Never throws — a key whose namespace has no
 * block resolves with empty strings, and the lint reports it.
 */
export function resolveKeyContext(key: MessageKey): ResolvedContext {
  const namespace = namespaceOf(key)
  const block = CATALOG_CONTEXT[namespace]
  const nsContext = block?._context
  const entry = block?.keys?.[key]
  return {
    key,
    namespace,
    source: en[key],
    surface: nsContext?.description ?? "",
    description: entry?.description ?? nsContext?.description ?? "",
    screenshot: entry?.screenshot ?? nsContext?.screenshot,
    maxLength: entry?.maxLength ?? nsContext?.maxLength,
    placeholders: { ...nsContext?.placeholders, ...entry?.placeholders },
  }
}

export const MESSAGE_KEYS = Object.keys(en) as MessageKey[]

/**
 * Lint the sidecar against the base catalog. Returns a human-readable issue per
 * problem; an empty array means the catalog is fully covered and consistent.
 *
 * Checks, in order:
 *  1. every message key's namespace has a usable `_context.description`;
 *  2. per-key descriptions are present and non-trivial when the entry exists;
 *  3. no orphan entries — every context key and namespace maps to a real key;
 *  4. every referenced screenshot id is declared in `screenshots.ts`;
 *  5. placeholders agree in both directions between the string and its context;
 *  6. every declared screenshot surface is actually referenced by the metadata.
 */
export function catalogContextIssues(): string[] {
  const issues: string[] = []
  const usedNamespaces = new Set<string>()
  const referencedShots = new Set<string>()

  for (const key of MESSAGE_KEYS) {
    const namespace = namespaceOf(key)
    usedNamespaces.add(namespace)
    const block = CATALOG_CONTEXT[namespace]
    if (!block) {
      issues.push(`${key}: no context block for namespace "${namespace}"`)
      continue
    }

    const nsDescription = block._context.description.trim()
    if (nsDescription.length < MIN_DESCRIPTION_LENGTH) {
      issues.push(
        `${namespace}._context.description is missing or too short ` +
          `(< ${MIN_DESCRIPTION_LENGTH} chars) — it must describe the surface`,
      )
    }

    const entry = block.keys?.[key]
    if (entry && entry.description.trim().length < MIN_DESCRIPTION_LENGTH) {
      issues.push(
        `${key}: description is too short (< ${MIN_DESCRIPTION_LENGTH} chars); ` +
          `drop the entry to inherit the namespace note instead`,
      )
    }

    const resolved = resolveKeyContext(key)
    if (resolved.screenshot) referencedShots.add(resolved.screenshot)
    if (resolved.screenshot && !isScreenshotId(resolved.screenshot)) {
      issues.push(
        `${key}: screenshot "${resolved.screenshot}" is not declared in screenshots.ts`,
      )
    }

    const used = placeholdersIn(en[key])
    for (const name of used) {
      if (!resolved.placeholders[name]) {
        issues.push(
          `${key}: placeholder {${name}} is used by the English string but has no ` +
            `entry in \`placeholders\` — a translator cannot know what it holds`,
        )
      }
    }
    for (const name of Object.keys(resolved.placeholders)) {
      if (!used.includes(name)) {
        issues.push(
          `${key}: \`placeholders\` documents {${name}}, which the English string ` +
            `does not use`,
        )
      }
    }
  }

  for (const [namespace, block] of Object.entries(CATALOG_CONTEXT)) {
    if (!usedNamespaces.has(namespace)) {
      issues.push(`namespace "${namespace}" has context but no message keys`)
    }
    for (const key of Object.keys(block.keys ?? {})) {
      if (!(key in en)) {
        issues.push(`${namespace}.keys["${key}"]: no such message key in the en catalog`)
      } else if (namespaceOf(key) !== namespace) {
        issues.push(
          `${namespace}.keys["${key}"]: key belongs to namespace ` +
            `"${namespaceOf(key)}" — move it there`,
        )
      }
    }
  }

  for (const block of Object.values(CATALOG_CONTEXT)) {
    if (block._context.screenshot) referencedShots.add(block._context.screenshot)
    for (const entry of Object.values(block.keys ?? {})) {
      if (entry?.screenshot) referencedShots.add(entry.screenshot)
    }
  }

  for (const surface of SCREENSHOTS) {
    if (!referencedShots.has(surface.id)) {
      issues.push(
        `screenshot surface "${surface.id}" is declared but no context entry ` +
          `references it — link it or remove it so the capture spec stays honest`,
      )
    }
  }

  return issues
}
