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
 * A key is *covered* when its namespace has a `_context.description`.
 * Per-key entries refine that note where present, but they're only
 * REQUIRED for a key in one of four classes — see `ContextRequirement` /
 * `requiresOwnContextEntry()` below (AQU-832 relaxation): a `{placeholder}`
 * to explain, a `plural()` form to reason about, a `maxLength` ceiling, or an
 * accessibility name a screen reader announces with no layout to lean on.
 * Everything else may skip an entry and inherit the namespace note — that's
 * what keeps coverage a class test instead of a per-key tax; see
 * `docs/I18N-CONTEXT-CATALOG.md` "why this changed" for the measured effect.
 * `catalogContextIssues()` is the lint that enforces coverage, class
 * membership, and placeholder agreement, and is run both by
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
import {
  isPluralMessage,
  PLURAL_CATEGORIES,
  type PluralCategory,
  type PluralMessage,
} from "./plurals"
import { isScreenshotId, SCREENSHOTS } from "./screenshots"

/**
 * Version of the sidecar interchange format emitted by `catalog-export.ts`.
 * v2 adds the `plurals` section — which categories each target locale needs for
 * each count-governed key, and which placeholder governs the selection.
 */
export const CONTEXT_SCHEMA_VERSION = 2

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

/**
 * The count-governed forms of a key, or `undefined` for a plain string key.
 * The one place the rest of the i18n code asks "is this key a plural?".
 */
export function pluralMessageFor(key: MessageKey): PluralMessage | undefined {
  const value = en[key]
  return isPluralMessage(value) ? value : undefined
}

/**
 * Every English string a key contributes — one for a plain key, one per authored
 * category for a plural key. The duplicate-English guard and the placeholder
 * lint both work over this, so a plural form cannot smuggle in a duplicate or an
 * undocumented placeholder.
 */
export function englishFormsFor(key: MessageKey): string[] {
  const value = en[key]
  if (!isPluralMessage(value)) return [value]
  return PLURAL_CATEGORIES.flatMap((c) => {
    const form = value.forms[c]
    return form === undefined ? [] : [form]
  })
}

/**
 * The single English string that represents a key — the `other` form for a
 * plural key, since that is the form every locale defines and the one a
 * translator reads first.
 */
export function englishSourceFor(key: MessageKey): string {
  const value = en[key]
  if (!isPluralMessage(value)) return value
  return value.forms.other ?? englishFormsFor(key)[0] ?? ""
}

/** Fully resolved context for one message key: per-key entry over namespace. */
export interface ResolvedContext {
  key: MessageKey
  namespace: string
  /** The English source string, for reference (`other` form when plural). */
  source: string
  /**
   * Present when the key is count-governed: the placeholder that selects the
   * form, and the authored English forms. Translators need both — the category
   * set they must fill depends on their language, not on English.
   */
  plural?: { countVar: string; forms: Partial<Record<PluralCategory, string>> }
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
  const plural = pluralMessageFor(key)
  return {
    key,
    namespace,
    source: englishSourceFor(key),
    ...(plural ? { plural: { countVar: plural.countVar, forms: plural.forms } } : {}),
    surface: nsContext?.description ?? "",
    description: entry?.description ?? nsContext?.description ?? "",
    screenshot: entry?.screenshot ?? nsContext?.screenshot,
    maxLength: entry?.maxLength ?? nsContext?.maxLength,
    placeholders: { ...nsContext?.placeholders, ...entry?.placeholders },
  }
}

export const MESSAGE_KEYS = Object.keys(en) as MessageKey[]

/**
 * The four classes of key that a generic namespace description cannot cover
 * (AQU-832 relaxation). A `{placeholder}` needs its meaning explained; a
 * count-governed message needs a translator to reason about its forms; a
 * length ceiling is a per-string layout fact, not a namespace-wide one; an
 * accessibility name is read by a screen reader with none of the surrounding
 * layout to lean on. Every other key — the overwhelming majority — is
 * adequately described by its namespace alone.
 *
 * This is what turns "context" from a per-key tax into a class test: at 1,337
 * keys, 1,143 (85.5%) had an authored per-key entry under the old convention;
 * under this test only 653 (48.8%) are classified as needing one — and that
 * number is the true floor, not an estimate, because it's the same corpus the
 * old convention already covered (see docs/I18N-CONTEXT-CATALOG.md "why this
 * changed" for the full before/after).
 */
export interface ContextRequirement {
  /** The English string (or a plural form of it) uses a `{placeholder}`. */
  placeholder: boolean
  /** The key is count-governed — authored with `plural()`. */
  plural: boolean
  /** The key's resolved context (its own or its namespace's) sets `maxLength`. */
  maxLength: boolean
  /** The key's name marks it as an accessibility name — see `looksLikeAccessibilityName`. */
  accessibilityName: boolean
}

/**
 * Key-name convention for an accessibility name: the segment naming what the
 * string is (an `aria-label`, `screenReader`-only text, an `sr-only`/
 * `visuallyHidden` node) rather than what surface it's on. Already the
 * dominant naming convention in this catalog — 80+ existing keys match it
 * (`nav.version.copyAriaLabel`, `editor.row.selectedAria`,
 * `search.ariaLabelProject`) — so this makes an existing practice load-bearing
 * rather than inventing a new one.
 *
 * This is a heuristic, not a certainty: it reads the catalog's own key names,
 * which is the only signal available to a module that deliberately doesn't
 * import the component tree (see the module doc). A string wired to
 * `aria-label` under a name that doesn't match — `autopilot.pill.stopRun`, a
 * plain imperative reused as its own accessible name — won't be caught here.
 * Where that matters, name the key so it says so; `catalogContextIssues()`
 * only sees what the name tells it.
 */
const ACCESSIBILITY_NAME_TOKENS = new Set([
  "aria",
  "arialabel",
  "screenreader",
  "sronly",
  "visuallyhidden",
])

export function looksLikeAccessibilityName(key: string): boolean {
  // Split into dot- and camelCase-delimited tokens rather than substring-
  // matching the whole key, so "logAria" → […, "Aria"] matches but a word
  // that merely CONTAINS "aria" — "librarian", "invariant", "aquarian" — does
  // not: those stay single un-split tokens because they have no camelCase
  // boundary of their own.
  const tokens = key
    .split(/[.\-_]|(?=[A-Z])/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
  return tokens.some((t) => ACCESSIBILITY_NAME_TOKENS.has(t))
}

/**
 * Which of the four context-requiring classes `key` falls into. Pure function
 * of the base catalog (`en.ts`) and the resolved sidecar — never of whether an
 * entry already exists, so it can't be satisfied by writing an entry rather
 * than by the key actually needing one.
 */
export function contextRequirementFor(key: MessageKey): ContextRequirement {
  const hasPlaceholder = englishFormsFor(key).some((form) => placeholdersIn(form).length > 0)
  return {
    placeholder: hasPlaceholder,
    plural: pluralMessageFor(key) !== undefined,
    maxLength: resolveKeyContext(key).maxLength !== undefined,
    accessibilityName: looksLikeAccessibilityName(key),
  }
}

/** Human-readable reasons for a `ContextRequirement`, for lint messages. */
export function contextRequirementReasons(req: ContextRequirement): string[] {
  const reasons: string[] = []
  if (req.placeholder) reasons.push("uses a {placeholder}")
  if (req.plural) reasons.push("is count-governed (plural())")
  if (req.maxLength) reasons.push("carries a maxLength ceiling")
  if (req.accessibilityName) reasons.push("is an accessibility name (aria-label/screen-reader)")
  return reasons
}

/**
 * Keys that predate this class-based requirement and still lack their own
 * entry, in a namespace module out of scope for this change to edit (see
 * docs/I18N-CONTEXT-CATALOG.md "why this changed"). This is not a blanket
 * exemption: `catalogContextIssues()` still requires each listed key to
 * actually need one — if a namespace owner adds the missing entry, the SAME
 * check reports that the listing is now stale and should be removed (see the
 * maintenance pass at the end of `catalogContextIssues()`), so this list
 * can't rot the way an unenforced convention could.
 *
 * Empty today: the one carry-over (`autopilot.inspector.activity.logAria`) got
 * its own entry once the owner of `autopilot.ts` cleared it.
 */
export const LEGACY_CONTEXT_GAPS: readonly MessageKey[] = []

/**
 * Does `key` need its own context entry, beyond inheriting the namespace
 * `_context.description`? True when any class in `ContextRequirement` holds.
 */
export function requiresOwnContextEntry(key: MessageKey): boolean {
  const req = contextRequirementFor(key)
  return req.placeholder || req.plural || req.maxLength || req.accessibilityName
}

/**
 * Lint the sidecar against the base catalog. Returns a human-readable issue per
 * problem; an empty array means the catalog is fully covered and consistent.
 *
 * Checks, in order:
 *  1. every message key's namespace has a usable `_context.description`;
 *  2. per-key descriptions are present and non-trivial when the entry exists;
 *  3. a key in a context-requiring class (placeholder, plural, maxLength, or
 *     accessibility name — see `ContextRequirement`) has an entry of its own;
 *     namespace inheritance alone is not enough for it. This is the check
 *     that makes coverage a class test instead of a per-key tax: everything
 *     NOT in one of those classes may skip an entry entirely and still pass;
 *  4. no orphan entries — every context key and namespace maps to a real key;
 *  5. every referenced screenshot id is declared in `screenshots.ts`;
 *  6. placeholders agree in both directions between the string and its context;
 *  7. every declared screenshot surface is actually referenced by the metadata.
 *
 * `legacyGaps` defaults to `LEGACY_CONTEXT_GAPS` and exists so the carve-out's
 * self-correcting behaviour stays testable while that list is empty.
 */
export function catalogContextIssues(
  legacyGaps: readonly MessageKey[] = LEGACY_CONTEXT_GAPS,
): string[] {
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

    // Check 3: the class test. A key outside every context-requiring class
    // may have zero entry at all and still pass — that's the relaxation. A
    // key inside one or more classes must have its own entry; a missing
    // description is caught above once it exists, so this only needs to
    // catch the entry being absent entirely. `LEGACY_CONTEXT_GAPS` is the one
    // deliberate carve-out — see its doc comment — and is verified separately
    // below rather than silently skipped here.
    if (!entry && !legacyGaps.includes(key)) {
      const req = contextRequirementFor(key)
      if (req.placeholder || req.plural || req.maxLength || req.accessibilityName) {
        issues.push(
          `${key}: needs its own context entry (${contextRequirementReasons(req).join("; ")}) ` +
            `— the namespace description alone isn't specific enough for it`,
        )
      }
    }

    const resolved = resolveKeyContext(key)
    if (resolved.screenshot) referencedShots.add(resolved.screenshot)
    if (resolved.screenshot && !isScreenshotId(resolved.screenshot)) {
      issues.push(
        `${key}: screenshot "${resolved.screenshot}" is not declared in screenshots.ts`,
      )
    }

    const plural = pluralMessageFor(key)
    if (plural) {
      const forms = englishFormsFor(key)
      if (!plural.forms.other || plural.forms.other.trim().length === 0) {
        issues.push(
          `${key}: plural message has no \`other\` form — it is the last form every ` +
            `locale defines and the end of every fallback chain, so it is required`,
        )
      }
      for (const [category, form] of Object.entries(plural.forms)) {
        if (form.trim().length === 0) {
          issues.push(`${key}: plural form "${category}" is empty`)
        }
      }
      // Every form must interpolate the same things, or the rendered sentence
      // silently loses a number in whichever category the count happens to hit.
      const signature = (s: string) => placeholdersIn(s).sort().join(",")
      const first = signature(forms[0] ?? "")
      for (const form of forms) {
        if (signature(form) !== first) {
          issues.push(
            `${key}: plural forms disagree on placeholders ` +
              `("${first}" vs "${signature(form)}") — every form must use the same set`,
          )
          break
        }
      }
    }

    const used = [...new Set(englishFormsFor(key).flatMap((form) => placeholdersIn(form)))]
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

  // Maintenance pass: keep LEGACY_CONTEXT_GAPS honest in both directions. A
  // listed key that isn't real, or that has since gotten its own entry (or
  // stopped needing one — e.g. the namespace maxLength that required it was
  // removed), must be dropped from the list rather than left to quietly keep
  // exempting a key that no longer needs it.
  for (const key of legacyGaps) {
    if (!MESSAGE_KEYS.includes(key)) {
      issues.push(`LEGACY_CONTEXT_GAPS lists "${key}", which is not a real message key — drop it`)
      continue
    }
    const namespace = namespaceOf(key)
    const hasEntry = CATALOG_CONTEXT[namespace]?.keys?.[key] !== undefined
    const stillNeedsOne = requiresOwnContextEntry(key)
    if (hasEntry || !stillNeedsOne) {
      issues.push(
        `LEGACY_CONTEXT_GAPS lists "${key}", which no longer needs the exemption ` +
          `(${hasEntry ? "it now has its own entry" : "it no longer falls into a context-requiring class"}) — drop it`,
      )
    }
  }

  return issues
}
