import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : []
  })
}

describe("E2E determinism guardrails", () => {
  it("runs before every standard E2E entrypoint", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> }
    const scripts = packageJson.scripts ?? {}

    expect(scripts["test:e2e:guard"]).toBe(
      "vitest run scripts/e2e-determinism.test.ts",
    )

    for (const scriptName of [
      "test:e2e:smoke",
      "test:e2e",
      "test:e2e:shard",
      "test:e2e:ui",
      "test:e2e:debug",
    ]) {
      expect(scripts[scriptName], `${scriptName} must run the policy guard`).toMatch(
        /^pnpm run test:e2e:guard && /,
      )
    }
  })

  it("keeps UI waits tied to observable state", () => {
    const files = [
      ...sourceFiles(path.join(REPO_ROOT, "e2e/specs")),
      ...sourceFiles(path.join(REPO_ROOT, "e2e/helpers")),
    ]
    const violations: string[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const relative = path.relative(REPO_ROOT, file)
      if (/\.waitForTimeout\s*\(/.test(source)) {
        violations.push(`${relative}: fixed browser sleep`)
      }
      if (/waitForLoadState\s*\(\s*["']networkidle["']\s*\)/.test(source)) {
        violations.push(`${relative}: networkidle used as application readiness`)
      }
      if (file.endsWith(".smoke.spec.ts") && /\.catch\(\s*\(\)\s*=>\s*false\s*\)/.test(source)) {
        violations.push(`${relative}: swallowed conditional probe`)
      }
      if (
        file.endsWith(".smoke.spec.ts")
        && /expect\([\s\S]{0,200}?\.locator\(\s*["']\[data-cell-id\]["']\s*\)\.first\(\)\s*\)\.toBeVisible/.test(source)
      ) {
        violations.push(`${relative}: bypasses Workspace.waitForEditor readiness contract`)
      }
    }

    expect(violations).toEqual([])
  })
})
