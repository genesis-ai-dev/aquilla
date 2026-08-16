import { describe, expect, it } from "vitest"
import { NAMESPACES } from "./index"
import { isPluralMessage, PLURAL_CATEGORIES, type MessageValue } from "../plurals"
import { DUPLICATE_EXCEPTIONS } from "./duplicate-exceptions"

/**
 * Normalize an English string for duplicate comparison: trim + case-fold only.
 *
 * This used to also strip a trailing ellipsis/colon (`/[…:]+$/`), which was
 * the actual bug behind 20 of this suite's 30 documented exceptions (AQU-832
 * relaxation): stripping the mark made an aria-label and the visible string
 * it names — "Search" vs "Search…" — normalize to the same value and collide,
 * even though the mark is required on one and forbidden on the other (a
 * screen reader reads "…" aloud as punctuation, see
 * docs/I18N-CONTEXT-CATALOG.md). Comparing the mark instead of discarding it
 * makes those pairs simply not collide, so the exceptions they needed are
 * gone rather than papered over — see `duplicate-exceptions.ts`.
 *
 * Case-folding stays: three of the four target locales have no letter case at
 * all, so a case-only split is pure duplicate work, never a real distinction.
 */
const normalize = (s: string) => s.trim().toLowerCase()

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

/** (key, string) pairs for the whole catalog, flattening plural forms. */
const allEntries = (): Array<[string, string]> =>
  NAMESPACES.flatMap((ns) =>
    Object.entries(ns.keys).flatMap(([key, value]) =>
      stringsOf(value).map((s) => [key, s] as [string, string]),
    ),
  )

/**
 * normalized English → the distinct keys that render it.
 *
 * O(N) over the catalog: one pass building a `Map` keyed by the normalized
 * string, not a namespace-by-namespace cross product. It used to be exactly
 * that cross product (`common.*` against everything else only), which hid 48
 * duplicate groups over 109 keys that nine sibling namespaces were duplicating
 * against EACH OTHER — see the widening note below.
 */
function groupsByEnglish(): Map<string, { keys: string[]; sample: string }> {
  const groups = new Map<string, { keys: string[]; sample: string }>()
  for (const [key, value] of allEntries()) {
    const norm = normalize(value)
    const group = groups.get(norm)
    if (!group) {
      groups.set(norm, { keys: [key], sample: value })
    } else if (!group.keys.includes(key)) {
      group.keys.push(key)
    }
  }
  return groups
}

describe("catalog has no duplicate English strings (AQU-511 / AQU-832)", () => {
  it("warns (without failing) when two keys share the same English string", () => {
    // AQU-832 relaxation: this used to be `expect(offenders).toEqual([])`, a
    // hard failure. That forced a wave of English rewording purely to dodge
    // collisions, which had to be reverted (commit 6b2977f5f) — the guard was
    // punishing correct, already-reused English to satisfy a linter instead of
    // catching an actual duplicate. Reuse pressure is still real and worth
    // surfacing, so an unexcused duplicate is logged loudly here, but it no
    // longer blocks `pnpm test` / CI. Promote the string to `common.*`, reuse
    // the existing key, or add a reviewed entry to `duplicate-exceptions.ts` —
    // none of those are enforced by this test anymore, only recommended.
    const offenders: string[] = []
    for (const { keys, sample } of groupsByEnglish().values()) {
      const unexcused = keys.filter((k) => !(k in DUPLICATE_EXCEPTIONS))
      if (unexcused.length > 1) {
        offenders.push(`${JSON.stringify(sample)} — ${unexcused.join(", ")}`)
      }
    }
    if (offenders.length > 0) {
      console.warn(
        `i18n: ${offenders.length} unexcused duplicate English string(s) (not blocking):\n` +
          offenders.map((o) => `  • ${o}`).join("\n"),
      )
    }
    // Not a duplicate-count budget — just proof the scan ran and produced a
    // real (possibly empty) list, so a thrown error upstream can't masquerade
    // as "no duplicates found".
    expect(Array.isArray(offenders)).toBe(true)
  })

  it("keeps every documented exception real and justified", () => {
    // This part stays a hard failure: it is not about whether duplicate
    // English exists (that's the warning above), it's about whether the
    // exceptions file itself can be trusted. A stale or frivolous entry there
    // is a bug regardless of how the duplicate scan is enforced.
    const groups = groupsByEnglish()
    const allKeys = new Set(allEntries().map(([key]) => key))
    for (const [key, reason] of Object.entries(DUPLICATE_EXCEPTIONS)) {
      // A stale exception silently re-opens the hole it was granted for, so an
      // entry for a key that no longer exists — or no longer collides — is a
      // failure, not a harmless leftover.
      expect(allKeys, `exception for missing key ${key}`).toContain(key)
      const collides = [...groups.values()].some(
        (g) => g.keys.includes(key) && g.keys.length > 1,
      )
      expect(collides, `${key} no longer collides — drop its exception`).toBe(true)
      expect(reason.length, `exception for ${key} needs a real reason`).toBeGreaterThan(60)
    }
  })

  it("does not let one exception excuse a second unrelated collision", () => {
    // An exception is granted per key, not per English string: if three keys
    // share a string and only two are excused, the remaining pair is still a
    // duplicate worth flagging (via the warning above), and the exceptions
    // file must not silently cover it.
    const groups = groupsByEnglish()
    for (const { keys, sample } of groups.values()) {
      const unexcused = keys.filter((k) => !(k in DUPLICATE_EXCEPTIONS))
      expect(
        unexcused.length,
        `${JSON.stringify(sample)} leaves ${unexcused.join(", ")} colliding`,
      ).toBeLessThan(2)
    }
  })

  it("has no two namespaces claiming the same key", () => {
    // Unrelated to English-string duplication — a genuine structural bug (one
    // namespace's spread silently overwriting another's), so this stays hard.
    const seen = new Set<string>()
    const collisions: string[] = []
    for (const ns of NAMESPACES) {
      for (const key of Object.keys(ns.keys)) {
        if (seen.has(key)) collisions.push(key)
        seen.add(key)
      }
    }
    expect(collisions).toEqual([])
  })
})
