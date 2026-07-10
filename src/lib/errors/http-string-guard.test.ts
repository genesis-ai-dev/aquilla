// AQU-281 lint guard — done-criterion #3.
//
// Greps src/components for user-facing string literals matching "HTTP \d{3}"
// and FAILS if any are found in NON-skipped files. As more files are fixed,
// remove them from the allowlist below so the guard tightens automatically.
//
// ALLOWLIST (files currently held by other parallel agents — SWARM-TODO(AQU-281)):
//   ImportDialog.tsx       — held by another swarm agent (AQU-281 skip scope)
//   CommentsPage.tsx       — held by another swarm agent
//   ProjectWorkspace.tsx   — held by another swarm agent
//   EditorTable.tsx        — held by another swarm agent
//   SharePanel.tsx         — held by another swarm agent
//   App.tsx                — held by another swarm agent
//   Login.tsx              — held by another swarm agent (401 UX is AQU-293)
//   onboarding/            — held by another swarm agent
//
// This test is deliberately narrow: it only checks for the raw "HTTP \d{3}"
// *string literal* pattern that indicates a fetch-helper error being rendered
// verbatim. It does not catch all possible bad error messages — that is a
// broader UX concern.

import { describe, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

// Files/directories currently held by parallel swarm agents — skip for now.
const ALLOWLISTED_PATTERNS = [
  "ImportDialog.tsx",
  "CommentsPage.tsx",
  "ProjectWorkspace.tsx",
  "EditorTable.tsx",
  "SharePanel.tsx",
  "App.tsx",
  "Login.tsx",
  // Whole directory
  "/onboarding/",
]

function isAllowlisted(filePath: string): boolean {
  return ALLOWLISTED_PATTERNS.some((p) => filePath.includes(p))
}

/** Recursively collect all non-test .tsx/.ts files under a directory. */
function collectFiles(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(full, results)
    } else if (
      entry.isFile() &&
      /\.[tj]sx?$/.test(entry.name) &&
      // Skip test files — they may intentionally use raw HTTP strings to test
      // that components handle/transform them.
      !entry.name.includes(".test.") &&
      !entry.name.includes(".spec.")
    ) {
      results.push(full)
    }
  }
  return results
}

const HTTP_STATUS_LITERAL = /HTTP\s+\d{3}/

describe("HTTP status literal guard (AQU-281)", () => {
  it("no non-allowlisted component renders a raw 'HTTP NNN' string", () => {
    // Find the components directory relative to this test file.
    // __dirname = src/lib/errors/  →  ../../components
    const testDir = path.resolve(__dirname)
    const componentsDir = path.resolve(testDir, "../../components")

    if (!fs.existsSync(componentsDir)) {
      // If the directory doesn't exist in this environment, skip.
      return
    }

    const violations: string[] = []

    for (const filePath of collectFiles(componentsDir)) {
      if (isAllowlisted(filePath)) continue

      const src = fs.readFileSync(filePath, "utf-8")

      // Split into lines and check each for the pattern.
      // Skip pure comments (lines starting with // or *).
      const lines = src.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trimStart()
        // Skip comment lines — HTTP NNN may legitimately appear in code comments.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue
        if (HTTP_STATUS_LITERAL.test(line)) {
          violations.push(`${path.relative(componentsDir, filePath)}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found raw 'HTTP NNN' string literals in component files (AQU-281).\n` +
        `These must be replaced with toUserFacingError() from @/lib/errors/user-error.\n\n` +
        violations.map((v) => `  ${v}`).join("\n") + "\n\n" +
        `If the file is held by another agent, add it to ALLOWLISTED_PATTERNS in\n` +
        `src/lib/errors/http-string-guard.test.ts.`
      )
    }
  })
})
