/**
 * Retired words (AQU-2261) — the one list of words the interface's English no
 * longer uses, each with the word to write instead.
 *
 * Sam agreed one word list for the interface on Oct 29 (docs/UI-GLOSSARY.md has
 * it as a table). Every English message was swept to it once; this list is what
 * keeps it that way. `pnpm i18n:check` (scripts/i18n-catalog.ts check) and
 * `retired-terms.test.ts` both fail when an English message — any plural form
 * of it — contains a retired word, and the failure names the word to use.
 *
 * Matching is case-insensitive, on whole words and phrases. `{placeholder}`
 * names are not words a person reads, so they are ignored ("{lane}" is fine).
 * A term may name `allowedIn` phrases that contain it legitimately: "lane" is
 * retired except inside "Language lane(s)".
 *
 * What this can't check, so the sweep did it by reading: "Language" used to
 * mean a lane, Project deadline vs Target date, "video" for the film, and
 * sentence case ("Font Size" vs "Font size" differ only in case).
 *
 * Code identifiers, URLs, event names and stored values are not English
 * messages and are never checked.
 */

import { en } from "./messages/en"
import { isPluralMessage, PLURAL_CATEGORIES, type MessageValue } from "./plurals"

export interface RetiredTerm {
  /** The retired word or phrase, as people would read it. */
  readonly term: string
  /** What to write instead — printed in the failure. */
  readonly use: string
  /**
   * Overrides the whole-phrase match built from `term`, for a retired pattern
   * rather than a word (a role's level number). Case-insensitive.
   */
  readonly pattern?: RegExp
  /** Phrases that contain the term legitimately; their text is skipped. */
  readonly allowedIn?: readonly RegExp[]
}

export const RETIRED_TERMS: readonly RetiredTerm[] = [
  { term: "View settings", use: "Editor settings" },
  { term: "audio media", use: "Media (the pane), or Audio loading (its card)" },
  { term: "Free timing", use: "Follows recordings" },
  { term: "Original timing", use: "Follows source" },
  { term: "the original recording's timing", use: "Follows source" },
  { term: "AI & completion", use: "AI (the pane), or AI model (advanced) (the model card)" },
  { term: "Advanced LLM", use: "AI model (advanced)" },
  {
    term: "AI instructions",
    use: "AI drafting (the card of drafting settings), or Instructions (the written ones)",
  },
  { term: "Local AI models", use: "On-device AI models" },
  { term: "Local models", use: "On-device AI models" },
  { term: "Bible resources", use: "Bible data" },
  { term: "Inherited settings", use: "Settings from {project}" },
  { term: "Copy these from the upstream project", use: "Settings from {project}" },
  { term: "Linked source project", use: "Source link" },
  { term: "Target lane", use: "Language lane" },
  { term: "Translation lane", use: "Language lane" },
  {
    term: "lane",
    use: "Language lane (plural Language lanes)",
    pattern: /\blanes?\b/gi,
    allowedIn: [/\blanguage lanes?\b/gi],
  },
  {
    term: "a role's level number, e.g. (500)",
    use: "the role's name alone, e.g. Project lead",
    pattern: /\((?:100|200|300|400|500|600|700)\)/g,
  },
  { term: "Link a video", use: "Link a film" },
  { term: "Link video", use: "Link film" },
  { term: "Change video", use: "Change film" },
  { term: "Clear video", use: "Clear film" },
  { term: "Collapse video", use: "Collapse film" },
  { term: "Linked video", use: "Linked film" },
  { term: "Video address", use: "Film address" },
  { term: "Billing & usage", use: "Billing" },
  { term: "Project title", use: "Project name" },
  { term: "roster", use: "member list" },
]

/**
 * Keys whose English must keep a retired word, each with a one-line reason.
 * Empty on purpose: Sam said not to worry about exceptions (Oct 29), and the
 * sweep found none that needed one. Add a key only with a real reason, e.g. an
 * admin or debug screen quoting an old name.
 */
export const RETIRED_TERM_ALLOWLIST: Readonly<Record<string, string>> = {}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whole-phrase, case-insensitive matcher for a plain retired term. */
function matcherFor(entry: RetiredTerm): RegExp {
  if (entry.pattern) return new RegExp(entry.pattern.source, entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`)
  const words = entry.term.trim().split(/\s+/).map(escapeRegExp).join("\\s+")
  const start = /^\w/.test(entry.term) ? "\\b" : ""
  const end = /\w$/.test(entry.term) ? "\\b" : ""
  return new RegExp(`${start}${words}${end}`, "gi")
}

/** What a person reads: the text with `{placeholder}` names taken out. */
function readableText(s: string): string {
  return s.replace(/\{[^{}]*\}/g, " ")
}

function englishForms(value: MessageValue): string[] {
  if (!isPluralMessage(value)) return [value]
  return PLURAL_CATEGORIES.flatMap((category) => {
    const form = value.forms[category]
    return form === undefined ? [] : [form]
  })
}

/** The retired terms in one English string, most specific first. */
export function retiredTermsIn(
  text: string,
  terms: readonly RetiredTerm[] = RETIRED_TERMS,
): RetiredTerm[] {
  let rest = readableText(text)
  const found: RetiredTerm[] = []
  for (const entry of terms) {
    let scanned = rest
    for (const allowed of entry.allowedIn ?? []) {
      scanned = scanned.replace(new RegExp(allowed.source, allowed.flags), " ")
    }
    const matcher = matcherFor(entry)
    if (matcher.test(scanned)) {
      found.push(entry)
      // A specific phrase ("Target lane") reports once, not again as "lane".
      rest = rest.replace(matcherFor(entry), " ")
    }
  }
  return found
}

/**
 * One line per English message that uses a retired word:
 *   `editor.view.x: "View settings" → write "Editor settings"`
 */
export function retiredTermIssues(
  catalog: Readonly<Record<string, MessageValue>> = en,
  allowlist: Readonly<Record<string, string>> = RETIRED_TERM_ALLOWLIST,
  terms: readonly RetiredTerm[] = RETIRED_TERMS,
): string[] {
  const issues: string[] = []
  for (const [key, value] of Object.entries(catalog)) {
    if (key in allowlist) continue
    const hits = new Map<string, RetiredTerm>()
    for (const form of englishForms(value)) {
      for (const entry of retiredTermsIn(form, terms)) hits.set(entry.term, entry)
    }
    for (const entry of hits.values()) {
      issues.push(`${key}: "${entry.term}" → write "${entry.use}"`)
    }
  }
  return issues
}
