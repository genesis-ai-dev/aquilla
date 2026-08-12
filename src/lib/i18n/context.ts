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
 * compile-time checking: an entry for a key that doesn't exist, or a screenshot
 * id that isn't declared in `screenshots.ts`, fails `tsc`.
 *
 * See `docs/I18N-CONTEXT-CATALOG.md` for the standard and the new-key workflow.
 */

import { en, type MessageKey } from "./messages/en"
import { isScreenshotId, SCREENSHOTS, type ScreenshotId } from "./screenshots"

/** Version of the sidecar interchange format emitted by `catalog-export.ts`. */
export const CONTEXT_SCHEMA_VERSION = 1

/** Minimum useful description length — a one-word note is not context. */
const MIN_DESCRIPTION_LENGTH = 12

export interface ContextEntry {
  /**
   * What the string does: element type (button / label / toast / tooltip /
   * heading), the action it triggers, and any wording constraint. Written for
   * someone who cannot see the code.
   */
  description: string
  /** Surface screenshot this string appears in; see `screenshots.ts`. */
  screenshot?: ScreenshotId
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
export const CATALOG_CONTEXT: Record<string, NamespaceBlock> = {
  common: {
    _context: {
      description:
        "Shared action verbs and status text reused across the whole app — mostly " +
        "buttons in dialog footers and toolbars, so they sit side by side with other " +
        "actions and must stay short and imperative.",
      screenshot: "confirm-dialog",
      maxLength: 20,
    },
    keys: {
      "common.save": {
        description:
          "Primary button that commits the changes in the current dialog or panel. " +
          "Imperative verb, not a noun ('Save', not 'Saving' or 'Saved').",
      },
      "common.cancel": {
        description:
          "Secondary button that closes a dialog and discards the changes made in it. " +
          "Pairs with Save; the two sit next to each other.",
      },
      "common.close": {
        description:
          "Button that dismisses a panel or dialog that has nothing to commit. Unlike " +
          "Cancel it does not imply discarding work.",
      },
      "common.delete": {
        description:
          "Destructive button that permanently removes the selected item. Should read " +
          "as clearly destructive in the target language.",
      },
      "common.dismiss": {
        description:
          "Button on a toast or inline notice that hides the message. It only hides the " +
          "notice; it does not undo or resolve whatever the notice reported.",
      },
      "common.retry": {
        description:
          "Button offered after a failed operation that attempts the same operation again.",
      },
      "common.loading": {
        description:
          "Placeholder status text shown while content is being fetched. The trailing " +
          "character is a single ellipsis glyph (…), not three periods; keep whatever " +
          "continuation mark is conventional in the target language.",
        screenshot: "cell-editor",
      },
    },
  },

  nav: {
    _context: {
      description:
        "Top-level workspace navigation — links and controls in the left sidebar and " +
        "app header that move the user between major areas. Rendered in a narrow " +
        "fixed-width column, so long translations wrap or clip.",
      screenshot: "workspace-nav",
      maxLength: 24,
    },
    keys: {
      "nav.projects": {
        description:
          "Sidebar link to the list of translation projects the user belongs to. Plural " +
          "noun naming a destination, not an action.",
      },
      "nav.settings": {
        description:
          "Sidebar link to the settings area. Plural noun naming a destination.",
      },
      "nav.search": {
        description:
          "Control that opens search across the project's cells. Noun or verb depending " +
          "on what reads naturally as a nav label in the target language.",
      },
    },
  },

  error: {
    _context: {
      description:
        "Failure surfaces — the error boundary and failed-load states. Wording is " +
        "reassuring and non-technical: it tells the user something broke without " +
        "blaming them and without exposing internals.",
      screenshot: "error-state",
    },
    keys: {
      "error.generic.title": {
        description:
          "Heading of the generic failure panel shown when an unexpected error is " +
          "caught. A short sentence, not a button; sentence case, no trailing period.",
      },
    },
  },

  fileDetails: {
    _context: {
      description:
        "The 'File details' modal, opened from a file row's overflow (⋯) menu in the " +
        "workspace sidebar. Shows a metadata table (label on the left, value on the " +
        "right) followed by a column of file action buttons; actions the user lacks " +
        "permission for are disabled with an explanatory sentence underneath.",
    },
    keys: {
      "fileDetails.menuItem": {
        description:
          "Menu item in the file row's overflow menu that opens the File details modal. " +
          "Noun phrase naming what will be shown, not an action verb.",
        maxLength: 24,
      },
      "fileDetails.importedAs": {
        description:
          "Subtitle under the modal heading, shown when the file was renamed after " +
          "import; tells the user the file's original name.",
        placeholders: {
          name: "The file's original name at import time, verbatim. Do not translate.",
        },
      },
      "fileDetails.type": {
        description:
          "Metadata row label for the file's source format (value is an acronym like " +
          "USFM or DOCX). Short noun.",
        maxLength: 20,
      },
      "fileDetails.corpus": {
        description:
          "Metadata row label for the corpus group the file belongs to (e.g. OT/NT for " +
          "biblical books). 'Corpus' is a product term for a named group of files.",
        maxLength: 20,
      },
      "fileDetails.bookCode": {
        description:
          "Metadata row label for the file's stable scripture book code (e.g. GEN). " +
          "Only shown for scripture files.",
        maxLength: 20,
      },
      "fileDetails.segments": {
        description:
          "Metadata row label for the number of translatable segments (cells) in the " +
          "file. Plural noun; the value is a bare number.",
        maxLength: 20,
      },
      "fileDetails.ordering": {
        description:
          "Metadata row label for how the file's segments are ordered. The value is " +
          "one of the two ordering names below.",
        maxLength: 20,
      },
      "fileDetails.orderingTimeline": {
        description:
          "Ordering value for time-based files (audio/video/subtitles): segments sort " +
          "by their timecodes. The parenthetical clarifies the mechanism.",
      },
      "fileDetails.orderingSequence": {
        description:
          "Ordering value for text files: segments sort by their intrinsic sequence " +
          "(e.g. verse order). Single noun.",
      },
      "fileDetails.languages": {
        description:
          "Metadata row label for the file's language pair. The value is rendered as " +
          "'source → target' language codes.",
        maxLength: 20,
      },
      "fileDetails.imported": {
        description:
          "Metadata row label for the date the file was imported. Past participle used " +
          "as a label; the value is a locale-formatted date.",
        maxLength: 20,
      },
      "fileDetails.progress": {
        description:
          "Metadata row label for the file's translation progress. The value is the " +
          "progressValue string below.",
        maxLength: 20,
      },
      "fileDetails.progressValue": {
        description:
          "Progress row value combining two percentages, separated by a middle dot. " +
          "'Translated' counts segments with a draft; 'validated' counts segments " +
          "approved by a reviewer.",
        placeholders: {
          translated: "Whole number 0–100: percentage of segments with a translation.",
          validated: "Whole number 0–100: percentage of segments validated by a reviewer.",
        },
      },
      "fileDetails.rename": {
        description:
          "Action button that closes the modal and starts inline renaming of the file " +
          "in the sidebar. Imperative verb.",
        maxLength: 24,
      },
      "fileDetails.moveToCorpus": {
        description:
          "Action button that opens a dialog to move the file into a different corpus " +
          "(named file group). Ends with an ellipsis because a dialog follows.",
        maxLength: 30,
      },
      "fileDetails.exportSource": {
        description:
          "Action button that downloads the file back in its source format. '.SFM' is " +
          "a file extension — keep it verbatim.",
        maxLength: 30,
      },
      "fileDetails.exportDisabledType": {
        description:
          "Sentence under the disabled export button explaining that only USFM-format " +
          "files can be exported. 'USFM' is a format name — keep it verbatim.",
      },
      "fileDetails.exportDisabledPolicy": {
        description:
          "Sentence under the disabled export button explaining that the user's " +
          "organization has turned off source export for members.",
      },
      "fileDetails.deleteRequiresRole": {
        description:
          "Sentence under the disabled delete button explaining the required project " +
          "role. 'Project Lead' is a role name shown elsewhere in the app; translate it " +
          "consistently with the members page.",
      },
    },
  },

  language: {
    _context: {
      description:
        "UI-language switcher in settings and the app chrome, which changes the " +
        "language of the interface itself (not the language being translated in the " +
        "project). These strings are read by someone who may not yet understand the " +
        "current UI language.",
      screenshot: "project-settings",
    },
    keys: {
      "language.label": {
        description:
          "Accessible label for the language switcher control. Read aloud by screen " +
          "readers; also the visible form label beside the control.",
        maxLength: 20,
      },
      "language.switchTo": {
        description:
          "Accessible description of a single option in the language switcher, naming " +
          "the language that option selects.",
        placeholders: {
          language:
            "Name of the target UI language, already written in that language's own " +
            "script (its endonym) — e.g. 'ไทย', 'العربية'. Do not translate the " +
            "substituted value.",
        },
      },
    },
  },
}

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
