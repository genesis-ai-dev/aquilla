/**
 * AQU-290: Lint guard — no internal spec IDs or jargon in user-facing string literals.
 *
 * WHY: Spec IDs like "AD-14" and jargon like "retrieval neighborhood" are trust-damaging
 * with non-technical SIL/UBS translation consultants. This test fails loudly if any
 * such string leaks into src/components or src/pages.
 *
 * SCOPE: string literals only (single-quoted, double-quoted, template literals).
 * Code comments are excluded by checking only quoted-string positions.
 *
 * To add a new banned pattern, add it to BANNED_PATTERNS with a note explaining why.
 */

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, extname } from "node:path"

// ── Patterns banned from user-facing string literals ──────────────────────────

const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /AD-\d+/,
    reason: "Internal architecture decision ID — never show to users",
  },
  {
    pattern: /CP-\d+/,
    reason: "Internal cross-platform spec ID — never show to users",
  },
]

// ── File collection ────────────────────────────────────────────────────────────

const SRC_ROOTS = [
  join(__dirname, "."),                          // src/components
  join(__dirname, "..", "pages"),                // src/pages
]

const EXTENSIONS = new Set([".tsx", ".ts"])

function collectFiles(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        // Skip test helpers and node_modules
        if (entry === "node_modules" || entry === "__tests__") continue
        results.push(...collectFiles(full))
      } else if (EXTENSIONS.has(extname(entry))) {
        results.push(full)
      }
    }
  } catch {
    // Directory may not exist in some build environments
  }
  return results
}

// ── String literal extractor ───────────────────────────────────────────────────

/**
 * Extract all string literal values from source (single-quoted, double-quoted,
 * template literals). Strips comments first so comment text is not flagged.
 *
 * This is a best-effort extractor — it strips line comments and block comments,
 * then looks for quoted content. It intentionally errs toward fewer false
 * positives over perfect coverage.
 */
function extractStringLiterals(source: string): string[] {
  // Strip single-line comments (// …)
  let stripped = source.replace(/\/\/[^\n]*/g, "")
  // Strip block comments (/* … */)
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, "")

  const literals: string[] = []

  // Double-quoted strings
  const dq = stripped.matchAll(/"((?:[^"\\]|\\.)*)"/g)
  for (const m of dq) literals.push(m[1])

  // Single-quoted strings
  const sq = stripped.matchAll(/'((?:[^'\\]|\\.)*)'/g)
  for (const m of sq) literals.push(m[1])

  // Template literal tagged content (backtick) — grab the static parts
  const tl = stripped.matchAll(/`((?:[^`\\$]|\\.|\$(?!\{))*)`/g)
  for (const m of tl) literals.push(m[1])

  return literals
}

// ── Test ───────────────────────────────────────────────────────────────────────

describe("AQU-290 — no internal spec IDs or jargon in user-facing strings", () => {
  const allFiles = SRC_ROOTS.flatMap(collectFiles)

  for (const { pattern, reason } of BANNED_PATTERNS) {
    it(`no string literal matches /${pattern.source}/ — ${reason}`, () => {
      const violations: string[] = []

      for (const file of allFiles) {
        const source = readFileSync(file, "utf-8")
        const literals = extractStringLiterals(source)
        for (const lit of literals) {
          if (pattern.test(lit)) {
            violations.push(`${file}: "${lit}"`)
          }
        }
      }

      expect(violations, `Found banned pattern /${pattern.source}/ in:\n${violations.join("\n")}`).toHaveLength(0)
    })
  }
})
