import type { NumberFormatConventions } from "../../../db/shared/number-format"
import type { PunctuationConventions } from "../../../db/shared/punctuation-conventions"

/**
 * AQU-1735: what the PROJECT calls each Bible book — the `\toc`/`\h` lines of
 * its files, a Paratext `BookNames.xml`, or the names its import gave the
 * files. The scripture-reference check judges a reference's book name against
 * this, so "Jn 3:17" is a finding in a project whose table says "Jhn".
 */
export interface ProjectBookName {
  /** USFM book code, e.g. "JHN". */
  code: string
  /** Every spelling the project uses for it ("Jhn", "John", "Yuhana"). */
  names: readonly string[]
}

/**
 * AQU-1906: per-LANE inputs a built-in check function may read, resolved once
 * where the rule set is built (`resolveBuiltinRules`) and carried on the
 * rule's `check` descriptor — not per cell, because none of it varies by cell.
 *
 * Its own module so a check function can import the type without importing the
 * registry that imports every check function.
 */
export interface BuiltinCheckRunContext {
  /**
   * The target lane's punctuation conventions. Absent or null keeps the
   * universal, source-relative sets the punctuation checks used before
   * AQU-1906 — which is what a lane with no recorded language gets.
   */
  punctuation?: PunctuationConventions | null
  /**
   * AQU-1735: the project's book-name table, for the scripture-reference
   * check. Absent or empty means the project has no table, and that check
   * then judges only the canon and the cell's own separators — it never
   * invents a "correct" spelling of its own.
   */
  bookNames?: readonly ProjectBookName[] | null
  /**
   * AQU-2430: how the target language writes numbers — its group and decimal
   * separators, its grouping, and its own digits — from
   * `resolveNumberFormat` (db/shared/number-format.ts). Absent or null leaves
   * the number-format check silent: with no recorded language and no Language
   * profile slot there is nothing to judge the number against, and judging it
   * by some other language's format would report correct typography.
   */
  numberFormat?: NumberFormatConventions | null
}
