// The stored shape of a translation rule's check. Alias-free and type-only so
// worker code (auth-worker has no `@/` path mapping) can import the style-rule
// types and the applicability resolver that reference it. src/lib/parsers/
// types.ts re-exports both names, so app imports are unchanged.

/** Text checks (db/shared/builtin-checks.ts) plus the Bible data checks
 *  (AQU-1688, "bkp:V1" …), which run from pack facts and exist only while the
 *  project's Bible data checks enrichment is on. */
export type BuiltinCheckId = import("../../../db/shared/builtin-checks").BuiltinCheckKey

export type RuleCheck =
  | { type: "source-requires-target"; sourcePattern: string; targetPattern: string; caseSensitive?: boolean }
  /**
   * `sourcePattern` (AQU-1712) is an optional SOURCE condition: when present,
   * the forbidden target pattern is only an infraction in a cell whose source
   * matches it. Compiled terminology rules carry the concept's source pattern,
   * because a forbidden rendering is wrong only as a rendering of that concept.
   * Hand-authored rules carry no `sourcePattern` and stay unconditional.
   */
  | { type: "target-forbids"; targetPattern: string; sourcePattern?: string; caseSensitive?: boolean }
  | { type: "source-target-match"; pattern: string }
  /**
   * `punctuation` (AQU-1906) is resolved per LANE by `resolveBuiltinRules`
   * and read by `rule-engine`'s builtin branch. It is never stored: built-in
   * rules are synthesized on read, so nothing persists a `check` carrying it.
   */
  | {
      type: "builtin"
      checkId: BuiltinCheckId
      punctuation?: import("../../../db/shared/punctuation-conventions").PunctuationConventions | null
    }
