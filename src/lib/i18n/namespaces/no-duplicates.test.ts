import { describe, expect, it } from "vitest"
import { NAMESPACES } from "./index"
import { common } from "./common"
import { isPluralMessage, PLURAL_CATEGORIES, type MessageValue } from "../plurals"

const normalize = (s: string) => s.trim().toLowerCase().replace(/[…:]+$/, "")

/**
 * Every English string a catalog value contributes. A count-governed key holds
 * one string per plural category, and a duplicate hiding in the `other` form is
 * still a duplicate a translator pays for.
 */
const stringsOf = (value: MessageValue): string[] =>
  isPluralMessage(value)
    ? PLURAL_CATEGORIES.flatMap((c) => {
        const form = value.forms[c]
        return form === undefined ? [] : [form]
      })
    : [value]

/** (key, string) pairs for every namespace, flattening plural forms. */
const allEntries = (): Array<[string, string]> =>
  NAMESPACES.flatMap((ns) =>
    Object.entries(ns.keys).flatMap(([key, value]) =>
      stringsOf(value).map((s) => [key, s] as [string, string]),
    ),
  )

/**
 * Same-English-different-meaning exceptions.
 *
 * The guard compares English strings, so it cannot see meaning — but identical
 * English does not always mean identical translation. A breadcrumb's overflow
 * affordance and a menu's overflow affordance are both "More" in English and are
 * routinely different words elsewhere, so collapsing them onto one key would
 * force one translation to be wrong. That is the exact failure this catalog
 * exists to prevent, so the exception is real.
 *
 * Default is deny: adding an entry here is a deliberate, reviewed act and the
 * reason must say why the two strings cannot share a translation. If the reason
 * is only "they happen to differ in code", reuse the shared key instead.
 */
const DISTINCT_MEANING: Record<string, string> = {
  "nav.sidebarSection.more":
    "Expands a collapsed sidebar section. common.moreBreadcrumbs is screen-reader " +
    "text for a truncated breadcrumb path — 'more of this path' vs 'expand this " +
    "group' are different acts and diverge in most target languages.",
  "audio.library.moreTooltip":
    "Overflow-menu tooltip in the voice library, i.e. 'more actions'. Distinct " +
    "from common.moreBreadcrumbs ('more of this path') for the same reason.",
}

describe("catalog has no duplicate English strings (AQU-511)", () => {
  it("does not re-key a string that common.* already provides", () => {
    const shared = new Map<string, string>()
    for (const [key, value] of Object.entries(common.keys)) {
      for (const s of stringsOf(value)) shared.set(normalize(s), key)
    }
    const offenders: string[] = []
    for (const ns of NAMESPACES) {
      if (ns === common) continue
      for (const [key, value] of Object.entries(ns.keys)) {
        if (key in DISTINCT_MEANING) continue
        for (const s of stringsOf(value)) {
          const existing = shared.get(normalize(s))
          if (existing) offenders.push(`${key} duplicates ${existing} ("${s}")`)
        }
      }
    }
    // Every unjustified duplicate is a string a human translator is asked to
    // translate twice, in four locales. Reuse the common.* key instead, or
    // document the distinction in DISTINCT_MEANING above.
    expect(offenders).toEqual([])
  })

  it("keeps every documented exception real and justified", () => {
    const allKeys = new Set(NAMESPACES.flatMap((ns) => Object.keys(ns.keys)))
    const sharedValues = new Set(
      Object.values(common.keys).flatMap((v) => stringsOf(v).map(normalize)),
    )
    for (const [key, reason] of Object.entries(DISTINCT_MEANING)) {
      // A stale exception silently re-opens the hole it was granted for, so an
      // entry for a key that no longer exists — or no longer collides — is a
      // failure, not a harmless leftover.
      expect(allKeys, `exception for missing key ${key}`).toContain(key)
      const value = allEntries().find(([k]) => k === key)?.[1]
      expect(sharedValues, `${key} no longer collides — drop its exception`).toContain(
        normalize(value ?? ""),
      )
      expect(reason.length, `exception for ${key} needs a real reason`).toBeGreaterThan(60)
    }
  })

  it("has no two namespaces claiming the same key", () => {
    const seen = new Set<string>()
    const collisions: string[] = []
    for (const ns of NAMESPACES) {
      for (const key of Object.keys(ns.keys)) {
        if (seen.has(key)) collisions.push(key)
        seen.add(key)
      }
    }
    // A collision means one namespace's spread silently overwrites another's.
    expect(collisions).toEqual([])
  })
})
